package ts

import (
	"bytes"
	"testing"
)

func TestCRC32KnownValue(t *testing.T) {
	// A PSI section including its own CRC has a CRC of zero.
	sec := BuildPAT(1, 0, 100, 4096)
	if CRC32(sec) != 0 {
		t.Fatalf("CRC of a complete section must be zero, got %08x", CRC32(sec))
	}
	// Reference vector: the MPEG-2 CRC of "123456789" is 0x0376E6E7.
	if got := CRC32([]byte("123456789")); got != 0x0376E6E7 {
		t.Fatalf("CRC32(123456789) = %08x, want 0376e6e7", got)
	}
}

func TestPATRoundTrip(t *testing.T) {
	pat, err := ParsePAT(BuildPAT(7, 3, 100, 4096))
	if err != nil {
		t.Fatal(err)
	}
	if pat.TSID != 7 || pat.Version != 3 || pat.Programs[100] != 4096 || len(pat.Programs) != 1 {
		t.Fatalf("unexpected PAT: %+v", pat)
	}
}

func TestPMTRoundTrip(t *testing.T) {
	want := PMT{
		Program: 100, Version: 5, PCRPID: 256,
		Streams: []ESInfo{
			{StreamType: 0x1B, PID: 256},
			{StreamType: 0x0F, PID: 257, Descriptors: []byte{0x0A, 0x04, 's', 'p', 'a', 0x00}},
		},
	}
	got, err := ParsePMT(BuildPMT(want))
	if err != nil {
		t.Fatal(err)
	}
	if got.Program != 100 || got.Version != 5 || got.PCRPID != 256 || len(got.Streams) != 2 {
		t.Fatalf("unexpected PMT: %+v", got)
	}
	if got.Streams[1].PID != 257 || !bytes.Equal(got.Streams[1].Descriptors, want.Streams[1].Descriptors) {
		t.Fatalf("descriptors lost: %+v", got.Streams[1])
	}
}

func TestSectionAcrossPackets(t *testing.T) {
	// A PMT with many streams needs more than one packet.
	pmt := PMT{Program: 1, PCRPID: 256}
	for i := 0; i < 20; i++ {
		pmt.Streams = append(pmt.Streams, ESInfo{StreamType: 0x0F, PID: uint16(300 + i), Descriptors: bytes.Repeat([]byte{0x0A}, 10)})
	}
	sec := BuildPMT(pmt)
	var cc byte
	packets := SectionPackets(0x100, sec, &cc)
	if len(packets) < 2 {
		t.Fatalf("expected a multi-packet section, got %d packet(s)", len(packets))
	}
	var asm Assembler
	var got [][]byte
	for _, p := range packets {
		got = append(got, asm.Push(p)...)
	}
	if len(got) != 1 || !bytes.Equal(got[0], sec) {
		t.Fatalf("section not rebuilt: %d sections", len(got))
	}
}

func TestAssemblerRejectsCorruptCRC(t *testing.T) {
	sec := BuildPAT(1, 0, 100, 4096)
	sec[len(sec)-1] ^= 0xFF
	var cc byte
	var asm Assembler
	for _, p := range SectionPackets(0, sec, &cc) {
		if got := asm.Push(p); len(got) != 0 {
			t.Fatal("a section with a bad CRC must be dropped")
		}
	}
}

func TestPacketFieldHelpers(t *testing.T) {
	p := NullPacket()
	if PID(p) != PIDNull || PayloadOffset(p) != 4 {
		t.Fatal("null packet fields wrong")
	}
	SetPID(p, 0x1234)
	if PID(p) != 0x1234 || p[1]&0xE0 != 0 {
		t.Fatalf("SetPID: pid=%x byte1=%02x", PID(p), p[1])
	}
	SetCC(p, 0x1F)
	if CC(p) != 0x0F {
		t.Fatal("SetCC must keep four bits")
	}
}

func TestPCRAndDiscontinuity(t *testing.T) {
	p := make([]byte, PacketSize)
	p[0], p[3] = SyncByte, 0x30
	p[4], p[5] = 7, 0x10
	// base = 1, extension = 2  -> 27 MHz value 1*300+2
	p[6], p[7], p[8], p[9], p[10], p[11] = 0, 0, 0, 0, 0x80, 0x02
	if v, ok := PCR(p); !ok || v != 302 {
		t.Fatalf("PCR = %d ok=%v, want 302", v, ok)
	}
	if !SetDiscontinuity(p) || p[5]&0x80 == 0 {
		t.Fatal("discontinuity flag not set")
	}
	if SetDiscontinuity(NullPacket()) {
		t.Fatal("a packet without adaptation field cannot carry the flag")
	}
}
