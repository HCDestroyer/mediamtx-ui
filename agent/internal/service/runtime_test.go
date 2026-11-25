package service

import (
	"context"
	"io"
	"log/slog"
	"net"
	"strconv"
	"sync"
	"testing"
	"time"

	"nodo/agent/internal/addr"
	"nodo/agent/internal/media"
	"nodo/agent/internal/stabilizer"
	"nodo/agent/internal/testutil"
	"nodo/agent/internal/ts"
)

var quiet = slog.New(slog.NewTextHandler(io.Discard, nil))

func freePort(t *testing.T) int {
	t.Helper()
	c, err := net.ListenUDP("udp4", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1)})
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	return c.LocalAddr().(*net.UDPAddr).Port
}

// sender replays a transport stream to a UDP port in a loop, until stopped.
type sender struct {
	stop context.CancelFunc
	done chan struct{}
}

func startSender(t *testing.T, data []byte, port int, kbps int) *sender {
	t.Helper()
	conn, err := net.DialUDP("udp4", nil, &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1), Port: port})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	s := &sender{stop: cancel, done: make(chan struct{})}
	go func() {
		defer close(s.done)
		defer conn.Close()
		const dgram = 7 * ts.PacketSize
		interval := time.Duration(float64(dgram*8) / float64(kbps*1000) * float64(time.Second))
		next := time.Now()
		for {
			for off := 0; off+dgram <= len(data); off += dgram {
				if ctx.Err() != nil {
					return
				}
				_, _ = conn.Write(data[off : off+dgram])
				next = next.Add(interval)
				time.Sleep(time.Until(next))
			}
		}
	}()
	return s
}

func (s *sender) Stop() { s.stop(); <-s.done }

// collector listens on the service output and keeps an analyzer of what comes out.
type collector struct {
	mu       sync.Mutex
	analyzer *ts.Analyzer
	packets  uint64
	pids     map[uint16]uint64
}

func startCollector(t *testing.T, ctx context.Context, port int) *collector {
	t.Helper()
	a, _ := addr.Parse("udp://127.0.0.1:" + strconv.Itoa(port))
	in, err := media.NewInput(a, media.Config{})
	if err != nil {
		t.Fatal(err)
	}
	c := &collector{analyzer: ts.NewAnalyzer(100), pids: map[uint16]uint64{}}
	go func() {
		_ = in.Run(ctx, func(chunk []byte) {
			c.mu.Lock()
			defer c.mu.Unlock()
			for off := 0; off+ts.PacketSize <= len(chunk); off += ts.PacketSize {
				p := chunk[off : off+ts.PacketSize]
				c.analyzer.Feed(p)
				c.packets++
				c.pids[ts.PID(p)]++
			}
		})
	}()
	return c
}

func (c *collector) snapshot() (program *ts.Program, ccErrors, packets uint64) {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.analyzer.Current(), c.analyzer.Stats.CCErrors, c.packets
}

func waitFor(t *testing.T, what string, within time.Duration, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(within)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for: %s", what)
}

func testService(in1, in2, out int) Service {
	s := Service{
		ID: "deportes", Name: "Deportes", Enabled: true,
		Inputs: []Input{
			{URL: "udp://127.0.0.1:" + strconv.Itoa(in1), TimeoutSec: 1},
			{URL: "udp://127.0.0.1:" + strconv.Itoa(in2), TimeoutSec: 1},
		},
		Backup:  Backup{Mode: ModeActive, ReturnDelaySec: 1},
		Outputs: []Output{{URL: "udp://127.0.0.1:" + strconv.Itoa(out)}},
		Profile: stabilizer.Profile{
			ServiceID: 100, PMTPID: 4096, Name: "Deportes", Provider: "Nodo",
			Streams: []stabilizer.OutStream{
				{PID: 256, Selector: stabilizer.Selector{Kind: ts.KindVideo}},
				{PID: 257, Selector: stabilizer.Selector{Kind: ts.KindAudio, Lang: "spa"}},
				{PID: 258, Selector: stabilizer.Selector{Kind: ts.KindAudio, Lang: "eng"}},
			},
		},
	}
	s.Normalize()
	return s
}

// The service the whole design exists for: two sources with different PIDs and language order, one of
// them failing and coming back, and a downstream device that must never notice.
func TestFailoverKeepsTheOutputStructure(t *testing.T) {
	srcA := testutil.MakeTS(t, 1331, []string{"eng", "spa"}, 2) // video 1331, eng 1332, spa 1333
	srcB := testutil.MakeTS(t, 2000, []string{"spa", "eng"}, 2) // video 2000, spa 2001, eng 2002
	in1, in2, out := freePort(t), freePort(t), freePort(t)

	ctx, cancel := context.WithTimeout(context.Background(), 40*time.Second)
	defer cancel()
	col := startCollector(t, ctx, out)

	rt, err := Start(ctx, testService(in1, in2, out), media.Config{}, quiet)
	if err != nil {
		t.Fatal(err)
	}
	defer rt.Stop()
	time.Sleep(200 * time.Millisecond)

	a := startSender(t, srcA, in1, 1500)
	b := startSender(t, srcB, in2, 1500)
	defer b.Stop()

	// 1. Input 1 (preferred) becomes the active one.
	waitFor(t, "input 1 active", 10*time.Second, func() bool { return rt.Status().ActiveInput == 0 })
	waitFor(t, "the output carries the fixed structure", 10*time.Second, func() bool {
		p, _, _ := col.snapshot()
		return p != nil && len(p.Streams) == 3
	})
	p, _, _ := col.snapshot()
	versionBefore := rt.Status().PMTVersion
	check := func(when string) {
		t.Helper()
		p, _, _ := col.snapshot()
		got := map[uint16]string{}
		for _, s := range p.Streams {
			got[s.PID] = string(s.Kind) + ":" + s.Lang
		}
		want := map[uint16]string{256: "video:", 257: "audio:spa", 258: "audio:eng"}
		if len(got) != 3 || got[256] != want[256] || got[257] != want[257] || got[258] != want[258] || p.PCRPID != 256 || p.Number != 100 {
			t.Fatalf("%s: the output structure changed: %+v", when, got)
		}
	}
	check("input 1")
	_ = p

	// 2. Input 1 dies: the service must move to input 2 with the same structure and no counter breaks.
	a.Stop()
	waitFor(t, "failover to input 2", 15*time.Second, func() bool { return rt.Status().ActiveInput == 1 })
	_, _, before := col.snapshot()
	waitFor(t, "data keeps flowing from input 2", 5*time.Second, func() bool {
		_, _, n := col.snapshot()
		return n > before+200
	})
	check("input 2")
	st := rt.Status()
	byOut := map[uint16]uint16{}
	for _, m := range st.Mapping {
		byOut[m.OutPID] = m.InPID
		if m.State != stabilizer.StateOK {
			t.Fatalf("mapping state after failover: %+v", m)
		}
	}
	if byOut[256] != 2000 || byOut[257] != 2001 || byOut[258] != 2002 {
		t.Fatalf("the output must now be fed by source B: %v", byOut)
	}
	if st.PMTVersion != versionBefore {
		t.Fatalf("PMT version moved %d -> %d although the output layout did not change", versionBefore, st.PMTVersion)
	}

	// 3. Input 1 comes back: after the return delay the service goes back to it.
	a2 := startSender(t, srcA, in1, 1500)
	defer a2.Stop()
	waitFor(t, "return to input 1", 15*time.Second, func() bool { return rt.Status().ActiveInput == 0 })
	check("input 1 again")

	// 4. Across the whole run the downstream analyzer saw no continuity error.
	time.Sleep(300 * time.Millisecond)
	if _, ccErrors, _ := col.snapshot(); ccErrors != 0 {
		t.Fatalf("downstream analyzer counted %d continuity errors across two switches", ccErrors)
	}
	if len(rt.Status().Events) < 3 {
		t.Fatalf("the switches must be logged, got %d event(s)", len(rt.Status().Events))
	}
}

func TestManualModeDoesNotSwitchByItself(t *testing.T) {
	srcA := testutil.MakeTS(t, 1331, []string{"eng", "spa"}, 2)
	srcB := testutil.MakeTS(t, 2000, []string{"spa", "eng"}, 2)
	in1, in2, out := freePort(t), freePort(t), freePort(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	svc := testService(in1, in2, out)
	svc.Backup.Mode = ModeManual
	rt, err := Start(ctx, svc, media.Config{}, quiet)
	if err != nil {
		t.Fatal(err)
	}
	defer rt.Stop()
	time.Sleep(200 * time.Millisecond)
	a := startSender(t, srcA, in1, 1500)
	b := startSender(t, srcB, in2, 1500)
	defer b.Stop()

	waitFor(t, "input 1 active", 10*time.Second, func() bool { return rt.Status().ActiveInput == 0 })
	// Even when the preferred input dies, manual mode before any other input is selected still needs
	// a source: the active one falling hands over only because there is no usable active input left.
	if err := rt.SwitchTo(1); err != nil {
		t.Fatal(err)
	}
	if rt.Status().ActiveInput != 1 {
		t.Fatal("manual switch did not apply")
	}
	// Input 1 is healthy and preferred, but manual mode must not return to it by itself.
	time.Sleep(2500 * time.Millisecond)
	if got := rt.Status().ActiveInput; got != 1 {
		t.Fatalf("manual mode returned to input %d without being asked", got+1)
	}
	a.Stop()
	if err := rt.SwitchTo(5); err == nil {
		t.Fatal("switching to a missing input must fail")
	}
}

func TestProfileChangeAppliesWithoutRestart(t *testing.T) {
	src := testutil.MakeTS(t, 1331, []string{"eng", "spa"}, 2)
	in1, in2, out := freePort(t), freePort(t), freePort(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	col := startCollector(t, ctx, out)
	svc := testService(in1, in2, out)
	rt, err := Start(ctx, svc, media.Config{}, quiet)
	if err != nil {
		t.Fatal(err)
	}
	defer rt.Stop()
	time.Sleep(200 * time.Millisecond)
	s := startSender(t, src, in1, 1500)
	defer s.Stop()
	waitFor(t, "running", 10*time.Second, func() bool {
		p, _, _ := col.snapshot()
		return rt.Status().ActiveInput == 0 && p != nil && len(p.Streams) == 3
	})
	uptime := rt.Status().UptimeSec

	next := svc.Profile
	next.Streams = append([]stabilizer.OutStream(nil), svc.Profile.Streams...)
	next.Streams[1].PID = 300 // the modulator now expects Spanish on PID 300
	if err := rt.UpdateProfile(next); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "new PID in the output", 5*time.Second, func() bool {
		p, _, _ := col.snapshot()
		if p == nil {
			return false
		}
		for _, s := range p.Streams {
			if s.PID == 300 && s.Lang == "spa" {
				return true
			}
		}
		return false
	})
	if rt.Status().UptimeSec < uptime {
		t.Fatal("the service restarted")
	}
	bad := next
	bad.Streams = nil
	if err := rt.UpdateProfile(bad); err == nil {
		t.Fatal("an invalid profile must be rejected and leave the running one alone")
	}
}

func TestStatusAndStop(t *testing.T) {
	in1, in2, out := freePort(t), freePort(t), freePort(t)
	svc := testService(in1, in2, out)
	rt, err := Start(context.Background(), svc, media.Config{}, quiet)
	if err != nil {
		t.Fatal(err)
	}
	st := rt.Status()
	if st.State != "running" || st.ActiveInput != -1 || len(st.Inputs) != 2 || len(st.Outputs) != 1 || len(st.Mapping) != 3 {
		t.Fatalf("unexpected status: %+v", st)
	}
	if st.Inputs[0].LastDataMs != -1 || st.Inputs[0].Up {
		t.Fatalf("an input with no data must say so: %+v", st.Inputs[0])
	}
	for _, m := range st.Mapping {
		if m.State != stabilizer.StateMissing {
			t.Fatalf("with no input everything is missing: %+v", m)
		}
	}
	rt.Stop()
	if got := rt.Status(); got.State != "stopped" {
		t.Fatalf("after Stop: %+v", got.State)
	}
}

func TestValidation(t *testing.T) {
	ok := testService(1111, 2222, 3333)
	if err := ok.Validate(media.Config{}); err != nil {
		t.Fatalf("reference service: %v", err)
	}
	mutate := map[string]func(s *Service){
		"id":        func(s *Service) { s.ID = "Bad Id" },
		"name":      func(s *Service) { s.Name = "" },
		"no inputs": func(s *Service) { s.Inputs = nil },
		"too many outputs": func(s *Service) {
			for len(s.Outputs) <= maxOutputs {
				s.Outputs = append(s.Outputs, Output{URL: "udp://127.0.0.1:9"})
			}
		},
		"bad input":     func(s *Service) { s.Inputs[0].URL = "nonsense" },
		"input scheme":  func(s *Service) { s.Inputs[0].URL = "gopher://x" },
		"bad pnr":       func(s *Service) { s.Inputs[0].URL = "udp://127.0.0.1:1#pnr=abc" },
		"bad output":    func(s *Service) { s.Outputs[0].URL = "http://x" },
		"output cbr":    func(s *Service) { s.Outputs[0].URL = "udp://127.0.0.1:1#cbr=4000" },
		"backup mode":   func(s *Service) { s.Backup.Mode = "passive" },
		"profile":       func(s *Service) { s.Profile.ServiceID = 0 },
		"mediamtx cfg":  func(s *Service) { s.Inputs[0].URL = "mediamtx://canal" },
		"negative wait": func(s *Service) { s.Inputs[0].TimeoutSec = -1 },
	}
	for name, f := range mutate {
		s := ok
		s.Inputs = append([]Input(nil), ok.Inputs...)
		s.Outputs = append([]Output(nil), ok.Outputs...)
		f(&s)
		if err := s.Validate(media.Config{}); err == nil {
			t.Errorf("%s: expected an error", name)
		}
	}
	// A service with no outputs is valid: it can be watched through HTTP play only.
	none := ok
	none.Inputs = append([]Input(nil), ok.Inputs...)
	none.Outputs = nil
	if err := none.Validate(media.Config{}); err != nil {
		t.Fatalf("no outputs must be valid: %v", err)
	}
	// mediamtx:// is fine once the agent knows where MediaMTX is.
	s := ok
	s.Inputs = []Input{{URL: "mediamtx://canal63"}}
	if err := s.Validate(media.Config{MediaMTXRTSP: "rtsp://127.0.0.1:8554"}); err != nil {
		t.Fatalf("mediamtx input: %v", err)
	}
}

func TestRedactURL(t *testing.T) {
	cases := map[string]string{
		"srt://h:1#passphrase=abc123&latency=200": "srt://h:1#passphrase=***&latency=200",
		"rtsp://agent:secret@127.0.0.1:8554/x":    "rtsp://***@127.0.0.1:8554/x",
		"rtmps://a.example/live2#key=abcd-1234":   "rtmps://a.example/live2#key=***",
		"udp://239.1.1.1:1234#pnr=100":            "udp://239.1.1.1:1234#pnr=100",
	}
	for in, want := range cases {
		if got := redactURL(in); got != want {
			t.Errorf("redactURL(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestHubFansOutAndNeverBlocks(t *testing.T) {
	h := newHub()
	a, _ := h.Subscribe()
	b, _ := h.Subscribe()
	h.Publish([]byte("x"))
	if string(<-a.Data) != "x" || string(<-b.Data) != "x" {
		t.Fatal("every viewer must get the data")
	}
	if h.Viewers() != 2 {
		t.Fatalf("viewers %d", h.Viewers())
	}
	// A viewer that never reads is cut after its queue fills; the other one keeps working.
	for i := 0; i < subscriberQueue+5; i++ {
		h.Publish([]byte("y"))
		select {
		case <-b.Data:
		default:
		}
	}
	if h.Viewers() != 1 || !a.Lagged() {
		t.Fatalf("slow viewer must be dropped: viewers=%d lagged=%v", h.Viewers(), a.Lagged())
	}
	if b.Lagged() {
		t.Fatal("a healthy viewer was cut")
	}
	a.Close() // closing a dropped viewer is harmless
	b.Close()
	b.Close()
	if h.Viewers() != 0 {
		t.Fatal("viewers left")
	}
}

func TestHubShutdownEndsViewersAndRefusesNewOnes(t *testing.T) {
	h := newHub()
	s, _ := h.Subscribe()
	h.Shutdown()
	if _, open := <-s.Data; open {
		t.Fatal("channel must be closed")
	}
	if s.Lagged() {
		t.Fatal("a stopped service is not a lagging viewer")
	}
	if _, ok := h.Subscribe(); ok {
		t.Fatal("subscribing to a stopped hub must fail")
	}
	h.Publish([]byte("z")) // must not panic
}
