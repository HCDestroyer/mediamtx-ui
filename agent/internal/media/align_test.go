package media

import (
	"bytes"
	"testing"

	"nodo/agent/internal/ts"
)

func stream(n int) []byte {
	var b []byte
	for i := 0; i < n; i++ {
		p := make([]byte, ts.PacketSize)
		p[0], p[1], p[2], p[3] = ts.SyncByte, 0x01, 0x00, 0x10|byte(i&0x0F)
		p[4] = byte(i)
		b = append(b, p...)
	}
	return b
}

func collect(a *Aligner, writes ...[]byte) []byte {
	var out []byte
	for _, w := range writes {
		a.Write(w, func(c []byte) { out = append(out, c...) })
	}
	return out
}

func TestAlignerPassesCleanStreamThrough(t *testing.T) {
	src := stream(100)
	var a Aligner
	got := collect(&a, src[:1000], src[1000:5000], src[5000:])
	// The last two packets stay buffered until a third arrives to confirm the boundary.
	if len(got)%ts.PacketSize != 0 || !bytes.Equal(got, src[:len(got)]) || len(got) < len(src)-ts.PacketSize*3 {
		t.Fatalf("got %d of %d bytes, aligned=%v", len(got), len(src), len(got)%ts.PacketSize == 0)
	}
}

func TestAlignerSkipsLeadingGarbage(t *testing.T) {
	src := stream(20)
	var a Aligner
	got := collect(&a, append([]byte{1, 2, 3, 0x47, 5, 6, 7}, src...))
	if len(got) == 0 || got[0] != ts.SyncByte || !bytes.Equal(got, src[:len(got)]) {
		t.Fatalf("did not resync on the real boundary: %d bytes", len(got))
	}
}

func TestAlignerRecoversAfterACorruptedStretch(t *testing.T) {
	a1, junk, a2 := stream(10), bytes.Repeat([]byte{0xAA}, 500), stream(30)
	var a Aligner
	got := collect(&a, a1, junk, a2)
	if len(got)%ts.PacketSize != 0 {
		t.Fatal("output must stay aligned")
	}
	for off := 0; off < len(got); off += ts.PacketSize {
		if got[off] != ts.SyncByte {
			t.Fatalf("packet at %d lost sync", off)
		}
	}
	if len(got) < (10+30-4)*ts.PacketSize {
		t.Fatalf("lost too much: %d bytes", len(got))
	}
}

func TestAlignerSurvivesSingleByteWrites(t *testing.T) {
	src := stream(12)
	var a Aligner
	var out []byte
	for _, b := range src {
		a.Write([]byte{b}, func(c []byte) { out = append(out, c...) })
	}
	if len(out)%ts.PacketSize != 0 || !bytes.Equal(out, src[:len(out)]) || len(out) < 9*ts.PacketSize {
		t.Fatalf("got %d bytes", len(out))
	}
}
