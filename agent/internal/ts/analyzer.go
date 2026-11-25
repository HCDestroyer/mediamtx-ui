package ts

// Kind classifies an elementary stream.
type Kind string

const (
	KindVideo    Kind = "video"
	KindAudio    Kind = "audio"
	KindSubtitle Kind = "subtitle"
	KindData     Kind = "data"
)

// Stream is an elementary stream of the selected program.
type Stream struct {
	PID         uint16 `json:"pid"`
	Type        byte   `json:"type"`
	Kind        Kind   `json:"kind"`
	Codec       string `json:"codec"`
	Lang        string `json:"lang,omitempty"`
	Descriptors []byte `json:"-"`
}

// Program is the selected program of an input as described by its PAT and PMT.
type Program struct {
	Number  uint16   `json:"number"`
	PMTPID  uint16   `json:"pmtPid"`
	PCRPID  uint16   `json:"pcrPid"`
	Version byte     `json:"version"`
	Streams []Stream `json:"streams"`
}

// descriptor tags used to classify private streams and read languages.
const (
	tagISO639      = 0x0A
	tagTeletext    = 0x56
	tagSubtitling  = 0x59
	tagAC3         = 0x6A
	tagEnhancedAC3 = 0x7A
	tagDTS         = 0x7B
	tagAAC         = 0x7C
)

// ClassifyStream maps a PMT entry to a kind and codec name.
func ClassifyStream(es ESInfo) (Kind, string) {
	switch es.StreamType {
	case 0x01:
		return KindVideo, "mpeg1video"
	case 0x02:
		return KindVideo, "mpeg2video"
	case 0x10:
		return KindVideo, "mpeg4video"
	case 0x1B:
		return KindVideo, "h264"
	case 0x24:
		return KindVideo, "hevc"
	case 0x03, 0x04:
		return KindAudio, "mp2"
	case 0x0F:
		return KindAudio, "aac"
	case 0x11:
		return KindAudio, "aac_latm"
	case 0x81:
		return KindAudio, "ac3"
	case 0x87:
		return KindAudio, "eac3"
	case 0x06:
		for _, tag := range descriptorTags(es.Descriptors) {
			switch tag {
			case tagAC3:
				return KindAudio, "ac3"
			case tagEnhancedAC3:
				return KindAudio, "eac3"
			case tagDTS:
				return KindAudio, "dts"
			case tagAAC:
				return KindAudio, "aac"
			case tagSubtitling, tagTeletext:
				return KindSubtitle, "dvbsub"
			}
		}
	}
	return KindData, "data"
}

func descriptorTags(d []byte) []byte {
	var tags []byte
	for i := 0; i+2 <= len(d); {
		tags = append(tags, d[i])
		i += 2 + int(d[i+1])
	}
	return tags
}

// Language reads the ISO 639 language of the first language descriptor.
func Language(d []byte) string {
	for i := 0; i+2 <= len(d); {
		tag, n := d[i], int(d[i+1])
		if i+2+n > len(d) {
			return ""
		}
		if tag == tagISO639 && n >= 3 {
			return string(d[i+2 : i+5])
		}
		i += 2 + n
	}
	return ""
}

// LanguageDescriptor builds an ISO 639 descriptor for a 3-letter code.
func LanguageDescriptor(lang string) []byte {
	if len(lang) != 3 {
		return nil
	}
	return []byte{tagISO639, 0x04, lang[0], lang[1], lang[2], 0x00}
}

// Stats are counters of one input.
type Stats struct {
	Packets  uint64
	Bytes    uint64
	CCErrors uint64
}

// Analyzer follows the PSI of one input and counts continuity errors.
// It is not safe for concurrent use: a single goroutine feeds it.
type Analyzer struct {
	// Program is the number of the program to follow; 0 follows the first one in the PAT.
	Program uint16

	pat      Assembler
	pmts     map[uint16]*Assembler // by PMT PID
	pmtPIDs  map[uint16]uint16     // program -> PMT PID
	selected uint16
	current  *Program
	lastCC   map[uint16]byte
	Stats    Stats
}

// NewAnalyzer creates an analyzer that follows the given program (0 = first).
func NewAnalyzer(program uint16) *Analyzer {
	return &Analyzer{
		Program: program,
		pmts:    map[uint16]*Assembler{},
		pmtPIDs: map[uint16]uint16{},
		lastCC:  map[uint16]byte{},
	}
}

// Current returns the program as last seen, or nil before a PMT arrived.
func (a *Analyzer) Current() *Program { return a.current }

// Feed processes one packet. It returns true when the followed program changed
// (first appearance, new stream layout, new PIDs or languages).
func (a *Analyzer) Feed(p []byte) bool {
	pid := PID(p)
	a.Stats.Packets++
	a.Stats.Bytes += PacketSize
	if pid != PIDNull && HasPayload(p) {
		if last, seen := a.lastCC[pid]; seen {
			cc := CC(p)
			// A repeated counter is a legal duplicate; anything else but +1 is a loss.
			if cc != last && cc != (last+1)&0x0F {
				a.Stats.CCErrors++
			}
		}
		a.lastCC[pid] = CC(p)
	}
	switch {
	case pid == PIDPAT:
		return a.onPAT(p)
	default:
		if asm, ok := a.pmts[pid]; ok {
			return a.onPMT(pid, asm, p)
		}
	}
	return false
}

func (a *Analyzer) onPAT(p []byte) bool {
	for _, sec := range a.pat.Push(p) {
		pat, err := ParsePAT(sec)
		if err != nil {
			continue
		}
		a.pmtPIDs = pat.Programs
		program := a.Program
		if program == 0 {
			for number := range pat.Programs {
				if program == 0 || number < program {
					program = number
				}
			}
		}
		pmtPID, ok := pat.Programs[program]
		if !ok {
			continue
		}
		if a.selected != program || a.pmts[pmtPID] == nil {
			a.selected = program
			a.pmts = map[uint16]*Assembler{pmtPID: {}}
		}
	}
	return false
}

func (a *Analyzer) onPMT(pid uint16, asm *Assembler, p []byte) bool {
	changed := false
	for _, sec := range asm.Push(p) {
		pmt, err := ParsePMT(sec)
		if err != nil || pmt.Program != a.selected {
			continue
		}
		next := &Program{Number: pmt.Program, PMTPID: pid, PCRPID: pmt.PCRPID, Version: pmt.Version}
		for _, es := range pmt.Streams {
			kind, codec := ClassifyStream(es)
			next.Streams = append(next.Streams, Stream{
				PID: es.PID, Type: es.StreamType, Kind: kind, Codec: codec,
				Lang: Language(es.Descriptors), Descriptors: es.Descriptors,
			})
		}
		if !samePrograms(a.current, next) {
			a.current = next
			changed = true
		}
	}
	return changed
}

// samePrograms ignores the PMT version: only a change of layout matters.
func samePrograms(a, b *Program) bool {
	if a == nil || b == nil {
		return a == b
	}
	if a.Number != b.Number || a.PCRPID != b.PCRPID || len(a.Streams) != len(b.Streams) {
		return false
	}
	for i := range a.Streams {
		x, y := a.Streams[i], b.Streams[i]
		if x.PID != y.PID || x.Type != y.Type || x.Lang != y.Lang {
			return false
		}
	}
	return true
}
