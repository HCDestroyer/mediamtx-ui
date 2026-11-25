package ts

import "errors"

var crcTable = func() [256]uint32 {
	var t [256]uint32
	for i := range t {
		c := uint32(i) << 24
		for j := 0; j < 8; j++ {
			if c&0x80000000 != 0 {
				c = c<<1 ^ 0x04C11DB7
			} else {
				c <<= 1
			}
		}
		t[i] = c
	}
	return t
}()

// CRC32 is the MPEG-2 CRC used by PSI sections (poly 0x04C11DB7, init 0xFFFFFFFF, no reflection).
func CRC32(data []byte) uint32 {
	crc := uint32(0xFFFFFFFF)
	for _, b := range data {
		crc = crc<<8 ^ crcTable[byte(crc>>24)^b]
	}
	return crc
}

// Assembler rebuilds PSI sections that span several packets of one PID.
type Assembler struct {
	buf     []byte
	started bool
}

// Push feeds one packet of the PID and returns every complete, CRC-valid section found.
func (a *Assembler) Push(p []byte) [][]byte {
	off := PayloadOffset(p)
	if off < 0 {
		return nil
	}
	payload := p[off:]
	if PUSI(p) {
		if len(payload) < 1 {
			return nil
		}
		pointer := int(payload[0])
		if 1+pointer > len(payload) {
			a.reset()
			return nil
		}
		// The tail of a section started in an earlier packet ends before the pointer.
		if a.started {
			a.buf = append(a.buf, payload[1:1+pointer]...)
		}
		out := a.drain()
		a.buf = append(a.buf[:0], payload[1+pointer:]...)
		a.started = true
		return append(out, a.drain()...)
	}
	if !a.started {
		return nil
	}
	a.buf = append(a.buf, payload...)
	return a.drain()
}

func (a *Assembler) reset() { a.buf, a.started = a.buf[:0], false }

// drain extracts complete sections from the buffer.
func (a *Assembler) drain() [][]byte {
	var out [][]byte
	for len(a.buf) >= 3 {
		if a.buf[0] == 0xFF { // stuffing: nothing else in this payload
			a.buf = a.buf[:0]
			break
		}
		length := 3 + int(a.buf[1]&0x0F)<<8 + int(a.buf[2])
		if length > 4096 {
			a.reset()
			break
		}
		if len(a.buf) < length {
			break
		}
		section := append([]byte(nil), a.buf[:length]...)
		a.buf = a.buf[length:]
		if length >= 4 && CRC32(section) == 0 {
			out = append(out, section)
		}
	}
	return out
}

// ---- tables ----

// PAT maps program numbers to PMT PIDs.
type PAT struct {
	TSID     uint16
	Version  byte
	Programs map[uint16]uint16
}

var ErrNotPAT = errors.New("not a PAT section")

// ParsePAT reads a PAT section (table_id 0).
func ParsePAT(sec []byte) (*PAT, error) {
	if len(sec) < 12 || sec[0] != 0x00 {
		return nil, ErrNotPAT
	}
	pat := &PAT{TSID: uint16(sec[3])<<8 | uint16(sec[4]), Version: sec[5] >> 1 & 0x1F, Programs: map[uint16]uint16{}}
	for i := 8; i+4 <= len(sec)-4; i += 4 {
		program := uint16(sec[i])<<8 | uint16(sec[i+1])
		pid := uint16(sec[i+2]&0x1F)<<8 | uint16(sec[i+3])
		if program != 0 { // program 0 points to the NIT
			pat.Programs[program] = pid
		}
	}
	return pat, nil
}

// ESInfo is one elementary stream of a PMT.
type ESInfo struct {
	StreamType  byte
	PID         uint16
	Descriptors []byte
}

// PMT describes one program.
type PMT struct {
	Program     uint16
	Version     byte
	PCRPID      uint16
	ProgramInfo []byte
	Streams     []ESInfo
}

var ErrNotPMT = errors.New("not a PMT section")

// ParsePMT reads a PMT section (table_id 2).
func ParsePMT(sec []byte) (*PMT, error) {
	if len(sec) < 16 || sec[0] != 0x02 {
		return nil, ErrNotPMT
	}
	pmt := &PMT{
		Program: uint16(sec[3])<<8 | uint16(sec[4]),
		Version: sec[5] >> 1 & 0x1F,
		PCRPID:  uint16(sec[8]&0x1F)<<8 | uint16(sec[9]),
	}
	end := len(sec) - 4
	infoLen := int(sec[10]&0x0F)<<8 | int(sec[11])
	if 12+infoLen > end {
		return nil, ErrNotPMT
	}
	pmt.ProgramInfo = append([]byte(nil), sec[12:12+infoLen]...)
	for i := 12 + infoLen; i+5 <= end; {
		esLen := int(sec[i+3]&0x0F)<<8 | int(sec[i+4])
		if i+5+esLen > end {
			return nil, ErrNotPMT
		}
		pmt.Streams = append(pmt.Streams, ESInfo{
			StreamType:  sec[i],
			PID:         uint16(sec[i+1]&0x1F)<<8 | uint16(sec[i+2]),
			Descriptors: append([]byte(nil), sec[i+5:i+5+esLen]...),
		})
		i += 5 + esLen
	}
	return pmt, nil
}

// withCRC finishes a section: section_length is patched in and the CRC appended.
func withCRC(sec []byte) []byte {
	length := len(sec) - 3 + 4
	sec[1] = sec[1]&0xF0 | byte(length>>8)&0x0F
	sec[2] = byte(length)
	crc := CRC32(sec)
	return append(sec, byte(crc>>24), byte(crc>>16), byte(crc>>8), byte(crc))
}

// BuildPAT serializes a single-program PAT.
func BuildPAT(tsid uint16, version byte, program, pmtPID uint16) []byte {
	sec := []byte{
		0x00, 0xB0, 0x00,
		byte(tsid >> 8), byte(tsid),
		0xC1 | version&0x1F<<1, 0x00, 0x00,
		byte(program >> 8), byte(program), 0xE0 | byte(pmtPID>>8)&0x1F, byte(pmtPID),
	}
	return withCRC(sec)
}

// BuildPMT serializes a PMT.
func BuildPMT(p PMT) []byte {
	sec := []byte{
		0x02, 0xB0, 0x00,
		byte(p.Program >> 8), byte(p.Program),
		0xC1 | p.Version&0x1F<<1, 0x00, 0x00,
		0xE0 | byte(p.PCRPID>>8)&0x1F, byte(p.PCRPID),
		0xF0 | byte(len(p.ProgramInfo)>>8)&0x0F, byte(len(p.ProgramInfo)),
	}
	sec = append(sec, p.ProgramInfo...)
	for _, es := range p.Streams {
		sec = append(sec,
			es.StreamType,
			0xE0|byte(es.PID>>8)&0x1F, byte(es.PID),
			0xF0|byte(len(es.Descriptors)>>8)&0x0F, byte(len(es.Descriptors)),
		)
		sec = append(sec, es.Descriptors...)
	}
	return withCRC(sec)
}

// BuildSDT serializes an SDT (actual transport stream) with one service.
func BuildSDT(tsid, originalNetwork, service uint16, provider, name string) []byte {
	desc := []byte{0x48, 0x00, 0x01, byte(len(provider))}
	desc = append(desc, provider...)
	desc = append(desc, byte(len(name)))
	desc = append(desc, name...)
	desc[1] = byte(len(desc) - 2)
	sec := []byte{
		0x42, 0xF0, 0x00,
		byte(tsid >> 8), byte(tsid),
		0xC1, 0x00, 0x00,
		byte(originalNetwork >> 8), byte(originalNetwork), 0xFF,
		byte(service >> 8), byte(service),
		0xFC,
		0x80 | byte(len(desc)>>8)&0x0F, byte(len(desc)), // running_status = 4, free_CA = 0
	}
	sec = append(sec, desc...)
	return withCRC(sec)
}

// SectionPackets splits a section into transport packets on the given PID.
// cc is the continuity counter to use for the first packet and is advanced.
func SectionPackets(pid uint16, section []byte, cc *byte) [][]byte {
	var out [][]byte
	data := append([]byte{0x00}, section...) // pointer_field
	for first := true; len(data) > 0; first = false {
		p := make([]byte, PacketSize)
		p[0] = SyncByte
		p[1] = byte(pid>>8) & 0x1F
		if first {
			p[1] |= 0x40
		}
		p[2] = byte(pid)
		p[3] = 0x10 | *cc&0x0F
		*cc = (*cc + 1) & 0x0F
		n := copy(p[4:], data)
		for i := 4 + n; i < PacketSize; i++ {
			p[i] = 0xFF
		}
		data = data[n:]
		out = append(out, p)
	}
	return out
}
