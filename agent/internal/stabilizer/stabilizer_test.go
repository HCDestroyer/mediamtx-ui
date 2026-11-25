package stabilizer

import (
	"bytes"
	"testing"
	"time"

	"nodo/agent/internal/ts"
)

// ---- helpers ----

// source builds the packets of a fake input stream.
type source struct {
	cc map[uint16]byte
}

func newSource() *source { return &source{cc: map[uint16]byte{}} }

// es returns a payload packet of the PID, optionally carrying a PCR in an adaptation field.
func (s *source) es(pid uint16, pcr bool) []byte {
	p := make([]byte, ts.PacketSize)
	p[0], p[1], p[2] = ts.SyncByte, byte(pid>>8)&0x1F, byte(pid)
	for i := 4; i < ts.PacketSize; i++ {
		p[i] = byte(pid) // payload tagged with the source PID
	}
	if pcr {
		p[3] = 0x30 | s.cc[pid]
		p[4], p[5] = 7, 0x10
		for i := 6; i < 12; i++ {
			p[i] = 0
		}
		for i := 12; i < ts.PacketSize; i++ {
			p[i] = byte(pid)
		}
	} else {
		p[3] = 0x10 | s.cc[pid]
	}
	s.cc[pid] = (s.cc[pid] + 1) & 0x0F
	return p
}

func program(pcr uint16, streams ...ts.Stream) *ts.Program {
	return &ts.Program{Number: 1, PMTPID: 4096, PCRPID: pcr, Streams: streams}
}

func video(pid uint16) ts.Stream {
	return ts.Stream{PID: pid, Type: 0x1B, Kind: ts.KindVideo, Codec: "h264"}
}
func audio(pid uint16, lang string) ts.Stream {
	return ts.Stream{PID: pid, Type: 0x0F, Kind: ts.KindAudio, Codec: "aac", Lang: lang, Descriptors: ts.LanguageDescriptor(lang)}
}

var profile = Profile{
	ServiceID: 100, PMTPID: 4096, Name: "Deportes", Provider: "Nodo",
	Streams: []OutStream{
		{PID: 256, Selector: Selector{Kind: ts.KindVideo}},
		{PID: 257, Selector: Selector{Kind: ts.KindAudio, Lang: "spa", FallbackAny: true}},
		{PID: 258, Selector: Selector{Kind: ts.KindAudio, Lang: "eng"}},
	},
}

type run struct {
	s   *Stabilizer
	out [][]byte
	now time.Time
}

func newRun(t *testing.T, p Profile) *run {
	t.Helper()
	s, err := New(p)
	if err != nil {
		t.Fatal(err)
	}
	return &run{s: s, now: time.Unix(1000, 0)}
}

func (r *run) feed(p []byte) {
	r.s.Process(p, r.now, func(o []byte) { r.out = append(r.out, append([]byte(nil), o...)) })
}

func (r *run) advance(d time.Duration) {
	r.now = r.now.Add(d)
	r.s.Tick(r.now, func(o []byte) { r.out = append(r.out, append([]byte(nil), o...)) })
}

// pids returns the set of PIDs in the output.
func (r *run) pids() map[uint16]int {
	m := map[uint16]int{}
	for _, p := range r.out {
		m[ts.PID(p)]++
	}
	return m
}

// ccBreaks counts continuity breaks of one output PID.
func (r *run) ccBreaks(pid uint16) int {
	last, seen, breaks := byte(0), false, 0
	for _, p := range r.out {
		if ts.PID(p) != pid || !ts.HasPayload(p) {
			continue
		}
		if seen && ts.CC(p) != (last+1)&0x0F {
			breaks++
		}
		last, seen = ts.CC(p), true
	}
	return breaks
}

func (r *run) lastPMT(t *testing.T) *ts.PMT {
	t.Helper()
	var asm ts.Assembler
	var pmt *ts.PMT
	for _, p := range r.out {
		if ts.PID(p) != 4096 {
			continue
		}
		for _, sec := range asm.Push(p) {
			parsed, err := ts.ParsePMT(sec)
			if err != nil {
				t.Fatal(err)
			}
			pmt = parsed
		}
	}
	if pmt == nil {
		t.Fatal("no PMT in the output")
	}
	return pmt
}

// ---- tests ----

func TestOutputUsesOnlyTheFixedPIDs(t *testing.T) {
	r := newRun(t, profile)
	r.s.SetProgram(program(1331, video(1331), audio(1332, "eng"), audio(1336, "spa")), false)
	src := newSource()
	for i := 0; i < 20; i++ {
		r.feed(src.es(1331, i%5 == 0))
		r.feed(src.es(1332, false))
		r.feed(src.es(1336, false))
		r.feed(src.es(0x1FFF, false)) // junk and null must not pass
	}
	pids := r.pids()
	for pid := range pids {
		switch pid {
		case 0, 4096, 0x11, 256, 257, 258:
		default:
			t.Fatalf("unexpected output PID %d", pid)
		}
	}
	if pids[256] != 20 || pids[257] != 20 || pids[258] != 20 {
		t.Fatalf("packets per PID: %v", pids)
	}
}

func TestStreamsAreChosenByLanguageNotByPosition(t *testing.T) {
	// The same channel seen twice: languages swapped and every PID renumbered.
	check := func(prog *ts.Program, spaIn, engIn uint16) {
		r := newRun(t, profile)
		r.s.SetProgram(prog, false)
		src := newSource()
		r.feed(src.es(spaIn, false))
		r.feed(src.es(engIn, false))
		var spa, eng byte
		for _, p := range r.out {
			switch ts.PID(p) {
			case 257:
				spa = p[10]
			case 258:
				eng = p[10]
			}
		}
		if spa != byte(spaIn) || eng != byte(engIn) {
			t.Fatalf("257 carries input %d (want %d), 258 carries %d (want %d)", spa, spaIn, eng, engIn)
		}
	}
	check(program(1331, video(1331), audio(1332, "eng"), audio(1336, "spa")), 1336, 1332)
	check(program(2000, video(2000), audio(2001, "spa"), audio(2002, "eng")), 2001, 2002)
}

func TestSourceRenumberingKeepsTheOutputStable(t *testing.T) {
	r := newRun(t, profile)
	src := newSource()
	r.s.SetProgram(program(1331, video(1331), audio(1332, "eng"), audio(1336, "spa")), false)
	for i := 0; i < 30; i++ {
		r.feed(src.es(1331, true))
		r.feed(src.es(1336, false))
	}
	before := r.lastPMT(t)
	versionBefore := r.s.PMTVersion()

	// The source moves audio spa to PID 1340 while running (same input: no switch).
	r.s.SetProgram(program(1331, video(1331), audio(1332, "eng"), audio(1340, "spa")), false)
	for i := 0; i < 30; i++ {
		r.feed(src.es(1331, true))
		r.feed(src.es(1340, false))
		r.advance(10 * time.Millisecond)
	}
	if got := r.ccBreaks(257); got != 0 {
		t.Fatalf("continuity broke %d time(s) on 257 when the source renumbered", got)
	}
	after := r.lastPMT(t)
	if !bytes.Equal(ts.BuildPMT(*before), ts.BuildPMT(*after)) || r.s.PMTVersion() != versionBefore {
		t.Fatal("the PMT must not change when only the source PIDs change")
	}
	for _, m := range r.s.Mapping() {
		if m.OutPID == 257 && (m.InPID != 1340 || m.State != StateOK) {
			t.Fatalf("mapping not updated: %+v", m)
		}
	}
}

func TestMissingStreamKeepsItsEntryAndSendsNothing(t *testing.T) {
	r := newRun(t, profile)
	r.s.SetProgram(program(1331, video(1331), audio(1336, "spa")), false) // no English audio
	src := newSource()
	for i := 0; i < 10; i++ {
		r.feed(src.es(1331, true))
		r.feed(src.es(1336, false))
	}
	if r.pids()[258] != 0 {
		t.Fatal("a missing stream must not produce packets")
	}
	pmt := r.lastPMT(t)
	found := false
	for _, es := range pmt.Streams {
		if es.PID == 258 {
			found = true
			if ts.Language(es.Descriptors) != "eng" {
				t.Fatalf("placeholder entry lost its language: %x", es.Descriptors)
			}
		}
	}
	if !found || len(pmt.Streams) != 3 {
		t.Fatalf("PMT must still list 3 streams, got %+v", pmt.Streams)
	}
	for _, m := range r.s.Mapping() {
		if m.OutPID == 258 && m.State != StateMissing {
			t.Fatalf("258 should be missing: %+v", m)
		}
	}
}

func TestFallbackTakesAnotherAudioOfTheSameKind(t *testing.T) {
	r := newRun(t, profile)
	r.s.SetProgram(program(1331, video(1331), audio(1332, "eng"), audio(1340, "fra")), false) // no Spanish
	var spa MapEntry
	for _, m := range r.s.Mapping() {
		if m.OutPID == 257 {
			spa = m
		}
	}
	if spa.State != StateFallback || spa.InPID != 1340 {
		t.Fatalf("257 should fall back to the French track left over: %+v", spa)
	}
}

func TestExactMatchesWinOverFallbacks(t *testing.T) {
	// English is needed by 258; 257 must not steal it as its fallback.
	r := newRun(t, profile)
	r.s.SetProgram(program(1331, video(1331), audio(1332, "eng")), false)
	for _, m := range r.s.Mapping() {
		switch m.OutPID {
		case 258:
			if m.State != StateOK || m.InPID != 1332 {
				t.Fatalf("258 must get the English audio: %+v", m)
			}
		case 257:
			if m.State != StateMissing {
				t.Fatalf("257 has nothing left: %+v", m)
			}
		}
	}
}

func TestPMTVersionChangesOnlyWhenContentChanges(t *testing.T) {
	r := newRun(t, profile)
	r.s.SetProgram(program(1331, video(1331), audio(1336, "spa"), audio(1332, "eng")), false)
	r.advance(0)
	v0 := r.s.PMTVersion()
	r.advance(150 * time.Millisecond)
	r.advance(150 * time.Millisecond)
	if r.s.PMTVersion() != v0 {
		t.Fatal("version moved without a change")
	}
	// The codec of the Spanish audio changes (AAC -> AC-3): that is a real change.
	ac3 := ts.Stream{PID: 1336, Type: 0x81, Kind: ts.KindAudio, Codec: "ac3", Lang: "spa"}
	r.s.SetProgram(program(1331, video(1331), ac3, audio(1332, "eng")), false)
	r.advance(150 * time.Millisecond)
	if r.s.PMTVersion() != (v0+1)&0x1F {
		t.Fatalf("version should have moved to %d, is %d", (v0+1)&0x1F, r.s.PMTVersion())
	}
}

func TestPSIIsRepeatedOnTime(t *testing.T) {
	r := newRun(t, profile)
	r.s.SetProgram(program(1331, video(1331)), false)
	for i := 0; i < 50; i++ { // 5 seconds of silence from the source
		r.advance(100 * time.Millisecond)
	}
	counts := r.pids()
	if counts[0] < 49 || counts[4096] < 49 {
		t.Fatalf("PAT/PMT every 100 ms expected, got PAT=%d PMT=%d", counts[0], counts[4096])
	}
	if counts[0x11] < 4 || counts[0x11] > 6 {
		t.Fatalf("SDT about once per second expected, got %d", counts[0x11])
	}
}

func TestPATPointsAtTheFixedService(t *testing.T) {
	r := newRun(t, profile)
	r.advance(0)
	var asm ts.Assembler
	for _, p := range r.out {
		if ts.PID(p) != 0 {
			continue
		}
		for _, sec := range asm.Push(p) {
			pat, err := ts.ParsePAT(sec)
			if err != nil {
				t.Fatal(err)
			}
			if pat.Programs[100] != 4096 || len(pat.Programs) != 1 {
				t.Fatalf("PAT = %+v", pat.Programs)
			}
			return
		}
	}
	t.Fatal("no PAT")
}

func TestSwitchingInputMarksTheDiscontinuityOnTheClock(t *testing.T) {
	r := newRun(t, profile)
	src := newSource()
	r.s.SetProgram(program(1331, video(1331), audio(1336, "spa")), false)
	for i := 0; i < 10; i++ {
		r.feed(src.es(1331, true))
	}
	// Backup input with other PIDs.
	r.s.SetProgram(program(2000, video(2000), audio(2002, "spa")), true)
	n := len(r.out)
	r.feed(src.es(2000, true))
	got := r.out[n]
	if ts.PID(got) != 256 || got[5]&0x80 == 0 {
		t.Fatalf("first packet after the switch must carry the discontinuity flag: pid=%d flags=%02x", ts.PID(got), got[5])
	}
	r.feed(src.es(2000, true))
	if r.out[n+1][5]&0x80 != 0 {
		t.Fatal("the flag must be set once, not on every packet")
	}
	if r.ccBreaks(256) != 0 {
		t.Fatal("continuity counters must stay continuous across the switch")
	}
}

func TestCBRPadsWithNullPackets(t *testing.T) {
	p := profile
	p.CBRKbps = 3008 // 2000 packets per second
	r := newRun(t, p)
	r.s.SetProgram(program(1331, video(1331)), false)
	r.advance(0)
	for i := 0; i < 100; i++ { // 1 s in 10 ms steps, no media at all
		r.advance(10 * time.Millisecond)
	}
	total := len(r.out)
	if total < 1950 || total > 2050 {
		t.Fatalf("expected about 2000 packets in one second at 3008 kbps, got %d", total)
	}
	if r.pids()[ts.PIDNull] < 1500 {
		t.Fatalf("most of the output should be null packets, got %d", r.pids()[ts.PIDNull])
	}
}

func TestCBRDoesNotFloodAfterAStall(t *testing.T) {
	p := profile
	p.CBRKbps = 3008
	r := newRun(t, p)
	r.advance(0)
	before := len(r.out)
	r.advance(30 * time.Second) // the process was paused
	if burst := len(r.out) - before; burst > 4000 {
		t.Fatalf("a %d packet burst after a stall would flood the modulator", burst)
	}
}

func TestPacketsWithoutPayloadRepeatTheCounter(t *testing.T) {
	r := newRun(t, profile)
	r.s.SetProgram(program(1331, video(1331)), false)
	src := newSource()
	r.feed(src.es(1331, true))
	afOnly := make([]byte, ts.PacketSize)
	afOnly[0], afOnly[1], afOnly[2], afOnly[3] = ts.SyncByte, 0x05, 0x33, 0x20|0x07
	afOnly[4], afOnly[5] = 183, 0x10
	r.feed(afOnly)
	r.feed(src.es(1331, true))
	var cc []byte
	for _, p := range r.out {
		if ts.PID(p) == 256 {
			cc = append(cc, ts.CC(p))
		}
	}
	if len(cc) != 3 || cc[1] != cc[0] || cc[2] != (cc[0]+1)&0x0F {
		t.Fatalf("counters %v: the adaptation-only packet must repeat the previous value", cc)
	}
}

func TestSeparateClockPIDIsKept(t *testing.T) {
	p := profile
	p.PCRPID = 300
	r := newRun(t, p)
	// The source carries its PCR on its own PID 1000, which no selector asks for.
	r.s.SetProgram(program(1000, video(1331), audio(1336, "spa")), false)
	src := newSource()
	r.feed(src.es(1000, true))
	if r.pids()[300] != 1 || r.lastPMT(t) == nil {
		t.Fatal("the clock PID must be forwarded as PID 300")
	}
	if r.lastPMT(t).PCRPID != 300 {
		t.Fatalf("PMT PCR_PID = %d, want 300", r.lastPMT(t).PCRPID)
	}
}

func TestProfileValidation(t *testing.T) {
	cases := map[string]func(p *Profile){
		"service":      func(p *Profile) { p.ServiceID = 0 },
		"pmt pid":      func(p *Profile) { p.PMTPID = 5 },
		"no streams":   func(p *Profile) { p.Streams = nil },
		"duplicate":    func(p *Profile) { p.Streams[1].PID = 256 },
		"pmt collides": func(p *Profile) { p.Streams[0].PID = 4096 },
		"bad kind":     func(p *Profile) { p.Streams[0].Kind = "foo" },
		"bad lang":     func(p *Profile) { p.Streams[1].Lang = "es" },
		"negative cbr": func(p *Profile) { p.CBRKbps = -1 },
	}
	for name, mutate := range cases {
		p := profile
		p.Streams = append([]OutStream(nil), profile.Streams...)
		mutate(&p)
		if _, err := New(p); err == nil {
			t.Errorf("%s: expected an error", name)
		}
	}
	if _, err := New(profile); err != nil {
		t.Fatalf("the reference profile must be valid: %v", err)
	}
}
