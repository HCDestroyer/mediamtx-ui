package stabilizer

import (
	"fmt"
	"time"

	"nodo/agent/internal/ts"
)

const (
	psiInterval = 100 * time.Millisecond // PAT and PMT, ETSI TR 101 211
	sdtInterval = time.Second
)

// Stabilizer turns the packets of whichever input is active into a stream with a fixed structure.
// It is driven by a single goroutine (the service loop) and is not safe for concurrent use.
type Stabilizer struct {
	profile Profile
	program *ts.Program
	res     []resolved
	byIn    map[uint16]uint16 // input PID -> output PID
	pcrOut  uint16

	next        map[uint16]byte // next continuity counter per output PID
	last        map[uint16]byte // last counter used, for packets without payload
	seen        map[uint16]bool
	pendingDisc map[uint16]bool

	lastType map[uint16]byte
	lastDesc map[uint16][]byte

	patCC, pmtCC, sdtCC byte
	pmtVersion          byte
	pmtBody             []byte // last PMT built with version 0, to detect changes
	lastPSI, lastSDT    time.Time

	cbrStart time.Time
	cbrSent  uint64
	scratch  [ts.PacketSize]byte

	// Counters for the status view.
	OutPackets  uint64
	NullPackets uint64
}

// New creates a stabilizer for a profile.
func New(profile Profile) (*Stabilizer, error) {
	if err := profile.Validate(); err != nil {
		return nil, err
	}
	s := &Stabilizer{
		next: map[uint16]byte{}, last: map[uint16]byte{}, seen: map[uint16]bool{},
		pendingDisc: map[uint16]bool{}, lastType: map[uint16]byte{}, lastDesc: map[uint16][]byte{},
	}
	s.profile = profile
	s.remap()
	return s, nil
}

// SetProfile replaces the output structure while running. Counters keep going, so a
// change of selectors or PIDs does not break continuity of the PIDs that stay.
func (s *Stabilizer) SetProfile(profile Profile) error {
	if err := profile.Validate(); err != nil {
		return err
	}
	s.profile = profile
	s.remap()
	return nil
}

// SetProgram tells the stabilizer what the active input looks like now. `switched` marks a change of
// input (failover): the next packet of each output PID that can carry it gets the discontinuity flag.
// A change of the same input (new PIDs or languages) is followed without any flag.
func (s *Stabilizer) SetProgram(program *ts.Program, switched bool) {
	s.program = program
	s.remap()
	if switched {
		for _, r := range s.res {
			s.pendingDisc[r.out.PID] = true
		}
		if s.pcrOut != 0 {
			s.pendingDisc[s.pcrOut] = true
		}
	}
}

// remap recomputes which input PID feeds which output PID.
func (s *Stabilizer) remap() {
	s.res = resolve(s.profile, s.program)
	s.byIn = map[uint16]uint16{}
	esOut := map[uint16]bool{}
	for _, r := range s.res {
		esOut[r.out.PID] = true
		if r.has {
			s.byIn[r.in.PID] = r.out.PID
		}
	}
	// The clock must come out on the PID the PMT names as PCR_PID.
	s.pcrOut = 0
	if s.program != nil {
		for _, r := range s.res {
			if r.has && r.in.PID == s.program.PCRPID {
				s.pcrOut = r.out.PID
			}
		}
		if s.pcrOut == 0 && s.program.PCRPID != 0 && s.profile.PCRPID != 0 && !esOut[s.profile.PCRPID] {
			// The source keeps its clock on a PID of its own: give it one in the output too.
			s.byIn[s.program.PCRPID] = s.profile.PCRPID
			s.pcrOut = s.profile.PCRPID
		}
	}
	if s.pcrOut == 0 {
		s.pcrOut = s.defaultPCR()
	}
}

func (s *Stabilizer) defaultPCR() uint16 {
	if s.profile.PCRPID != 0 {
		return s.profile.PCRPID
	}
	for _, st := range s.profile.Streams {
		if st.Kind == ts.KindVideo {
			return st.PID
		}
	}
	return s.profile.Streams[0].PID
}

// Mapping returns the live mapping for the status view.
func (s *Stabilizer) Mapping() []MapEntry {
	out := make([]MapEntry, len(s.res))
	for i, r := range s.res {
		out[i] = MapEntry{OutPID: r.out.PID, State: r.state, Kind: r.out.Kind, Lang: r.out.Lang}
		if r.has {
			out[i].InPID = r.in.PID
			if r.in.Lang != "" {
				out[i].Lang = r.in.Lang
			}
		}
	}
	return out
}

// PMTVersion is the version number of the PMT being sent.
func (s *Stabilizer) PMTVersion() byte { return s.pmtVersion }

// Process handles one packet of the active input. emit receives output packets and must copy
// them if it keeps them: the slice is reused.
func (s *Stabilizer) Process(p []byte, now time.Time, emit func([]byte)) {
	s.Tick(now, emit)
	out, ok := s.byIn[ts.PID(p)]
	if !ok {
		return // PSI, nulls and streams the profile does not ask for
	}
	buf := s.scratch[:]
	copy(buf, p)
	ts.SetPID(buf, out)
	if ts.HasPayload(buf) {
		cc := s.next[out]
		ts.SetCC(buf, cc)
		s.last[out] = cc
		s.next[out] = (cc + 1) & 0x0F
	} else {
		// A packet without payload repeats the previous counter.
		ts.SetCC(buf, s.last[out])
	}
	s.seen[out] = true
	if s.pendingDisc[out] && ts.SetDiscontinuity(buf) {
		delete(s.pendingDisc, out)
	}
	s.send(buf, emit)
}

// Tick emits what is due without input: PAT/PMT every 100 ms, SDT every second, and padding for CBR.
func (s *Stabilizer) Tick(now time.Time, emit func([]byte)) {
	if s.lastPSI.IsZero() || now.Sub(s.lastPSI) >= psiInterval {
		s.lastPSI = now
		s.emitPSI(emit)
	}
	if s.profile.Name != "" && (s.lastSDT.IsZero() || now.Sub(s.lastSDT) >= sdtInterval) {
		s.lastSDT = now
		for _, p := range ts.SectionPackets(ts.PIDSDT, ts.BuildSDT(s.profile.ServiceID, 1, s.profile.ServiceID, s.profile.Provider, s.profile.Name), &s.sdtCC) {
			s.send(p, emit)
		}
	}
	if s.profile.CBRKbps > 0 {
		s.pad(now, emit)
	}
}

func (s *Stabilizer) pad(now time.Time, emit func([]byte)) {
	if s.cbrStart.IsZero() {
		s.cbrStart = now
	}
	perSecond := float64(s.profile.CBRKbps) * 1000 / (8 * ts.PacketSize)
	target := uint64(now.Sub(s.cbrStart).Seconds() * perSecond)
	if target > s.cbrSent+uint64(perSecond) {
		s.cbrSent = target // fell more than a second behind: do not flood the output to catch up
		return
	}
	null := ts.NullPacket()
	for s.cbrSent < target {
		s.NullPackets++
		s.send(null, emit)
	}
}

func (s *Stabilizer) send(p []byte, emit func([]byte)) {
	s.OutPackets++
	s.cbrSent++
	emit(p)
}

func (s *Stabilizer) emitPSI(emit func([]byte)) {
	pat := ts.BuildPAT(s.profile.ServiceID, 0, s.profile.ServiceID, s.profile.PMTPID)
	for _, p := range ts.SectionPackets(ts.PIDPAT, pat, &s.patCC) {
		s.send(p, emit)
	}
	for _, p := range ts.SectionPackets(s.profile.PMTPID, s.buildPMT(), &s.pmtCC) {
		s.send(p, emit)
	}
}

// buildPMT writes the PMT of the profile. Streams without a source keep their entry (with the last
// type and descriptors seen, or defaults), so the structure the downstream device sees never shrinks.
func (s *Stabilizer) buildPMT() []byte {
	pmt := ts.PMT{Program: s.profile.ServiceID, PCRPID: s.pcrOut}
	for _, r := range s.res {
		pid := r.out.PID
		if r.has {
			s.lastType[pid], s.lastDesc[pid] = r.in.Type, r.in.Descriptors
		}
		st, ok := s.lastType[pid]
		if !ok {
			st = defaultType(r.out.Kind)
		}
		desc := s.lastDesc[pid]
		if len(desc) == 0 && r.out.Lang != "" {
			desc = ts.LanguageDescriptor(r.out.Lang)
		}
		pmt.Streams = append(pmt.Streams, ts.ESInfo{StreamType: st, PID: pid, Descriptors: desc})
	}
	// The version changes only when the content does.
	pmt.Version = 0
	body := ts.BuildPMT(pmt)
	if s.pmtBody != nil && string(body) != string(s.pmtBody) {
		s.pmtVersion = (s.pmtVersion + 1) & 0x1F
	}
	s.pmtBody = body
	pmt.Version = s.pmtVersion
	return ts.BuildPMT(pmt)
}

func defaultType(k ts.Kind) byte {
	switch k {
	case ts.KindVideo:
		return 0x1B
	case ts.KindAudio:
		return 0x0F
	}
	return 0x06
}

// String summarizes the profile, for logs.
func (p Profile) String() string {
	return fmt.Sprintf("service %d pmt %d, %d stream(s)", p.ServiceID, p.PMTPID, len(p.Streams))
}
