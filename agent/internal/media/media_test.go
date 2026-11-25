package media

import (
	"bytes"
	"context"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"nodo/agent/internal/addr"
	"nodo/agent/internal/ts"
)

func freeUDPPort(t *testing.T) int {
	t.Helper()
	c, err := net.ListenUDP("udp4", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1)})
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	return c.LocalAddr().(*net.UDPAddr).Port
}

func mustAddr(t *testing.T, s string) addr.Address {
	t.Helper()
	a, err := addr.Parse(s)
	if err != nil {
		t.Fatal(err)
	}
	return a
}

// roundTrip sends packets through a UDP output into a UDP input and returns what arrived.
func roundTrip(t *testing.T, scheme string, packets int) []byte {
	t.Helper()
	port := freeUDPPort(t)
	in, err := NewInput(mustAddr(t, scheme+"://127.0.0.1:"+itoa(port)), Config{})
	if err != nil {
		t.Fatal(err)
	}
	out, err := NewOutput(mustAddr(t, scheme+"://127.0.0.1:"+itoa(port)+"#pkt=7"), Config{})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	var got []byte
	done := make(chan struct{})
	go func() {
		defer close(done)
		_ = in.Run(ctx, func(c []byte) {
			got = append(got, c...)
			if len(got) >= (packets-3)*ts.PacketSize { // the aligner holds back the last packets
				cancel()
			}
		})
	}()
	time.Sleep(100 * time.Millisecond) // let the socket bind

	ch := make(chan []byte, 16)
	go func() { _ = out.Run(ctx, ch) }()
	var src []byte
	for i := 0; i < packets; i++ {
		p := make([]byte, ts.PacketSize)
		p[0], p[1], p[2], p[3], p[4] = ts.SyncByte, 0x01, 0x00, 0x10|byte(i&0x0F), byte(i)
		src = append(src, p...)
	}
	for off := 0; off < len(src); off += 7 * ts.PacketSize {
		ch <- src[off:min(off+7*ts.PacketSize, len(src))]
		time.Sleep(time.Millisecond)
	}
	<-done
	if len(got) == 0 || !bytes.Equal(got, src[:len(got)]) {
		t.Fatalf("received %d bytes, which do not match what was sent", len(got))
	}
	return got
}

func itoa(n int) string {
	return strings.TrimSpace(strings.Replace(string(rune('0'+n/10000%10))+string(rune('0'+n/1000%10))+string(rune('0'+n/100%10))+string(rune('0'+n/10%10))+string(rune('0'+n%10)), "\x00", "", -1))
}

func TestUDPLoopback(t *testing.T) { roundTrip(t, "udp", 140) }
func TestRTPLoopback(t *testing.T) { roundTrip(t, "rtp", 140) }

func TestRTPPayloadParsing(t *testing.T) {
	plain := append([]byte{0x80, 33, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0}, 0x47, 1)
	if got := rtpPayload(plain); len(got) != 2 || got[0] != 0x47 {
		t.Fatalf("plain header: %v", got)
	}
	withCSRC := append([]byte{0x82, 33, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2}, 0x47)
	if got := rtpPayload(withCSRC); len(got) != 1 || got[0] != 0x47 {
		t.Fatalf("with CSRC: %v", got)
	}
	withExt := append([]byte{0x90, 33, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0xBE, 0xDE, 0, 1, 9, 9, 9, 9}, 0x47)
	if got := rtpPayload(withExt); len(got) != 1 || got[0] != 0x47 {
		t.Fatalf("with extension: %v", got)
	}
	for _, bad := range [][]byte{nil, {0x80}, {0x40, 33, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0x47}, make([]byte, 12)} {
		if rtpPayload(bad) != nil {
			t.Fatalf("%v should be rejected", bad)
		}
	}
}

func TestUDPOutputOptionsAreValidated(t *testing.T) {
	for _, bad := range []string{"udp://239.1.1.1:1234#ttl=0", "udp://239.1.1.1:1234#pkt=8", "udp://239.1.1.1:1234#ttl=abc", "udp://239.1.1.1:1234#cbr=4000"} {
		if _, err := NewOutput(mustAddr(t, bad), Config{}); err == nil {
			t.Errorf("%s should be rejected", bad)
		}
	}
	if _, err := NewOutput(mustAddr(t, "udp://239.1.1.1:1234#ttl=16&pkt=7"), Config{}); err != nil {
		t.Fatal(err)
	}
}

func TestSchemeDispatch(t *testing.T) {
	cfg := Config{MediaMTXRTSP: "rtsp://127.0.0.1:8554", MediaMTXUser: "agent", MediaMTXPass: "p@ss/word"}
	for _, ok := range []string{"udp://239.1.1.1:1", "rtp://239.1.1.1:1", "http://h/x.ts", "http://h/x.m3u8", "https://h/x.ts", "rtsp://h/x", "rtmp://h/x", "srt://h:1", "mediamtx://canal63", "file:///tmp/x.ts#rate=4000"} {
		if _, err := NewInput(mustAddr(t, ok), cfg); err != nil {
			t.Errorf("input %s: %v", ok, err)
		}
	}
	for _, ok := range []string{"udp://239.1.1.1:1", "rtp://239.1.1.1:1", "mediamtx://canal63", "rtmps://a/b#key", "srt://h:1", "file:///tmp/o.ts"} {
		if _, err := NewOutput(mustAddr(t, ok), cfg); err != nil {
			t.Errorf("output %s: %v", ok, err)
		}
	}
	if _, err := NewInput(mustAddr(t, "gopher://x"), cfg); err == nil {
		t.Error("unknown input scheme must be rejected")
	}
	if _, err := NewOutput(mustAddr(t, "http://x"), cfg); err == nil {
		t.Error("http output is not supported")
	}
	if _, err := NewInput(mustAddr(t, "mediamtx://x"), Config{}); err == nil {
		t.Error("mediamtx:// without a configured MediaMTX must fail with an explanation")
	}
}

func TestMediaMTXURLEncodesCredentials(t *testing.T) {
	cfg := Config{MediaMTXRTSP: "rtsp://127.0.0.1:8554", MediaMTXUser: "agent", MediaMTXPass: "p@ss/word"}
	got, err := cfg.mediaMTXURL("cams/patio")
	if err != nil {
		t.Fatal(err)
	}
	if got != "rtsp://agent:p%40ss%2Fword@127.0.0.1:8554/cams/patio" {
		t.Fatalf("got %s", got)
	}
}

func TestFFmpegArguments(t *testing.T) {
	in := strings.Join(ffmpegInputArgs("rtsp://127.0.0.1:8554/canal63"), " ")
	for _, want := range []string{"-rtsp_transport tcp", "-i rtsp://127.0.0.1:8554/canal63", "-c copy", "-f mpegts pipe:1", "-nostdin"} {
		if !strings.Contains(in, want) {
			t.Errorf("input args miss %q: %s", want, in)
		}
	}
	if strings.Contains(strings.Join(ffmpegInputArgs("srt://h:1"), " "), "rtsp_transport") {
		t.Error("rtsp transport only applies to rtsp inputs")
	}
	out := strings.Join(ffmpegOutputArgs("rtsp://127.0.0.1:8554/svc", "rtsp"), " ")
	for _, want := range []string{"-f mpegts -i pipe:0", "-c copy", "-rtsp_transport tcp", "-f rtsp rtsp://127.0.0.1:8554/svc"} {
		if !strings.Contains(out, want) {
			t.Errorf("output args miss %q: %s", want, out)
		}
	}
}

func TestRedactHidesCredentials(t *testing.T) {
	if got := Redact("rtsp://agent:secret@127.0.0.1:8554/x"); strings.Contains(got, "secret") || !strings.Contains(got, "127.0.0.1:8554/x") {
		t.Fatalf("redact = %s", got)
	}
	if got := Redact("rtsp://127.0.0.1/x"); got != "rtsp://127.0.0.1/x" {
		t.Fatalf("redact must leave plain URLs alone: %s", got)
	}
	if got := Redact("http://h/p@th"); got != "http://h/p@th" {
		t.Fatalf("an @ in the path is not a credential: %s", got)
	}
}

// FFmpeg really reads a stream and hands over aligned transport-stream packets.
func TestFFmpegInputReadsRealMedia(t *testing.T) {
	ffmpeg, err := exec.LookPath("ffmpeg")
	if err != nil {
		t.Skip("ffmpeg not installed")
	}
	file := filepath.Join(t.TempDir(), "in.ts")
	cmd := exec.Command(ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=160x120:rate=25",
		"-f", "lavfi", "-i", "sine=frequency=440", "-t", "1", "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", "-f", "mpegts", file)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("%v\n%s", err, out)
	}
	in, _ := newFFmpegInput(file, Config{})
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	var total int
	var an = ts.NewAnalyzer(0)
	err = in.Run(ctx, func(c []byte) {
		if len(c)%ts.PacketSize != 0 || c[0] != ts.SyncByte {
			t.Errorf("chunk not aligned: %d bytes", len(c))
		}
		for off := 0; off < len(c); off += ts.PacketSize {
			an.Feed(c[off : off+ts.PacketSize])
		}
		total += len(c)
	})
	if err == nil || !strings.Contains(err.Error(), "ffmpeg stopped reading") {
		t.Logf("finished with: %v", err) // reaching the end of the file is reported as a stop, which the service loop restarts
	}
	if total < 20*ts.PacketSize {
		t.Fatalf("only %d bytes", total)
	}
	if p := an.Current(); p == nil || len(p.Streams) != 2 {
		t.Fatalf("the PSI of the stream was not understood: %+v", p)
	}
}

func TestFileInputPlaysInALoopAtARate(t *testing.T) {
	file := filepath.Join(t.TempDir(), "x.ts")
	var data []byte
	for i := 0; i < 70; i++ {
		p := make([]byte, ts.PacketSize)
		p[0], p[1], p[2], p[3] = ts.SyncByte, 0x01, 0x00, 0x10|byte(i&0x0F)
		data = append(data, p...)
	}
	if err := os.WriteFile(file, data, 0o600); err != nil {
		t.Fatal(err)
	}
	in, err := NewInput(mustAddr(t, "file://"+file+"#rate=4000"), Config{})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 400*time.Millisecond)
	defer cancel()
	var total int
	_ = in.Run(ctx, func(c []byte) { total += len(c) })
	// 4000 kbps = 500 kB/s: about 200 kB in 400 ms, which is more than the 13 kB file: it looped.
	if total < len(data)*2 {
		t.Fatalf("the file did not loop: %d bytes", total)
	}
	if total > 260_000 {
		t.Fatalf("playback ran faster than the configured rate: %d bytes in 400 ms", total)
	}
}
