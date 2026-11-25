// Package ts implements the parts of MPEG-2 transport streams the agent needs:
// packet fields, PSI/SI tables and a per-input analyzer.
package ts

const (
	PacketSize = 188
	SyncByte   = 0x47

	PIDPAT  = 0x0000
	PIDSDT  = 0x0011
	PIDNull = 0x1FFF
)

// PID returns the packet identifier of a 188-byte packet.
func PID(p []byte) uint16 { return uint16(p[1]&0x1F)<<8 | uint16(p[2]) }

// SetPID rewrites the packet identifier.
func SetPID(p []byte, pid uint16) {
	p[1] = p[1]&0xE0 | byte(pid>>8)&0x1F
	p[2] = byte(pid)
}

// PUSI reports the payload_unit_start_indicator.
func PUSI(p []byte) bool { return p[1]&0x40 != 0 }

// HasAdaptation reports whether the packet carries an adaptation field.
func HasAdaptation(p []byte) bool { return p[3]&0x20 != 0 }

// HasPayload reports whether the packet carries a payload.
func HasPayload(p []byte) bool { return p[3]&0x10 != 0 }

// CC returns the continuity counter.
func CC(p []byte) byte { return p[3] & 0x0F }

// SetCC rewrites the continuity counter.
func SetCC(p []byte, cc byte) { p[3] = p[3]&0xF0 | cc&0x0F }

// PayloadOffset returns where the payload starts, or -1 when the packet has none or is malformed.
func PayloadOffset(p []byte) int {
	if !HasPayload(p) {
		return -1
	}
	off := 4
	if HasAdaptation(p) {
		off += 1 + int(p[4])
	}
	if off >= PacketSize {
		return -1
	}
	return off
}

// PCR returns the program clock reference (27 MHz ticks) when the packet carries one.
func PCR(p []byte) (uint64, bool) {
	if !HasAdaptation(p) || p[4] < 7 || p[5]&0x10 == 0 {
		return 0, false
	}
	base := uint64(p[6])<<25 | uint64(p[7])<<17 | uint64(p[8])<<9 | uint64(p[9])<<1 | uint64(p[10])>>7
	ext := uint64(p[10]&0x01)<<8 | uint64(p[11])
	return base*300 + ext, true
}

// SetDiscontinuity flags a discontinuity in the adaptation field. It returns false when the
// packet has no adaptation field to carry the flag.
func SetDiscontinuity(p []byte) bool {
	if !HasAdaptation(p) || p[4] < 1 {
		return false
	}
	p[5] |= 0x80
	return true
}

// NullPacket builds a null packet (PID 0x1FFF).
func NullPacket() []byte {
	p := make([]byte, PacketSize)
	p[0] = SyncByte
	p[1] = 0x1F
	p[2] = 0xFF
	p[3] = 0x10
	for i := 4; i < PacketSize; i++ {
		p[i] = 0xFF
	}
	return p
}
