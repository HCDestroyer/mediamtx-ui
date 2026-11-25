package stabilizer

import (
	"testing"
	"time"

	"nodo/agent/internal/testutil"
	"nodo/agent/internal/ts"
)

// play pushes the packets of a stream through an analyzer and the stabilizer, like the service loop does.
func play(t *testing.T, data []byte, a *ts.Analyzer, st *Stabilizer, now *time.Time, switched bool, sink func([]byte)) {
	t.Helper()
	first := true
	for off := 0; off+ts.PacketSize <= len(data); off += ts.PacketSize {
		p := data[off : off+ts.PacketSize]
		if p[0] != ts.SyncByte {
			t.Fatalf("lost sync at %d", off)
		}
		changed := a.Feed(p)
		if changed || first {
			if a.Current() != nil {
				st.SetProgram(a.Current(), switched && first)
				first = false
			}
		}
		*now = now.Add(time.Millisecond)
		st.Process(p, *now, sink)
	}
}

// The scenario that motivated the stabilizer: the source is replaced by one that renumbers every PID
// and lists its languages in another order. The modulator must see no change at all.
func TestRealStreamsWithDifferentLayoutsGiveTheSameOutput(t *testing.T) {
	a := testutil.MakeTS(t, 1331, []string{"eng", "spa"}, 2) // video 1331, eng 1332, spa 1333
	b := testutil.MakeTS(t, 2000, []string{"spa", "eng"}, 2) // video 2000, spa 2001, eng 2002

	st, err := New(profile)
	if err != nil {
		t.Fatal(err)
	}
	out := ts.NewAnalyzer(100)
	var emitted [][]byte
	sink := func(p []byte) {
		cp := append([]byte(nil), p...)
		emitted = append(emitted, cp)
		out.Feed(cp)
	}
	now := time.Unix(5000, 0)

	inA := ts.NewAnalyzer(0)
	play(t, a, inA, st, &now, false, sink)
	layoutA := inA.Current()
	if layoutA == nil || layoutA.PCRPID != 1331 {
		t.Fatalf("source A not understood: %+v", layoutA)
	}
	pmtVersion := st.PMTVersion()

	inB := ts.NewAnalyzer(0)
	play(t, b, inB, st, &now, true, sink)
	if inB.Current() == nil || inB.Current().PCRPID != 2000 {
		t.Fatalf("source B not understood: %+v", inB.Current())
	}

	got := out.Current()
	if got == nil {
		t.Fatal("the output carries no PMT")
	}
	want := map[uint16]struct {
		kind ts.Kind
		lang string
	}{256: {ts.KindVideo, ""}, 257: {ts.KindAudio, "spa"}, 258: {ts.KindAudio, "eng"}}
	if len(got.Streams) != 3 || got.PCRPID != 256 {
		t.Fatalf("output layout: %+v", got)
	}
	for _, s := range got.Streams {
		w, ok := want[s.PID]
		if !ok || s.Kind != w.kind || s.Lang != w.lang {
			t.Fatalf("output stream %+v does not match the profile", s)
		}
	}
	if st.PMTVersion() != pmtVersion {
		t.Fatalf("PMT version moved from %d to %d although the layout of the output did not change", pmtVersion, st.PMTVersion())
	}
	if out.Stats.CCErrors != 0 {
		t.Fatalf("a downstream analyzer counted %d continuity error(s) across the switch", out.Stats.CCErrors)
	}
	for _, m := range st.Mapping() {
		if m.State != StateOK {
			t.Fatalf("mapping after the switch: %+v", m)
		}
	}
	// Source B must really be feeding the output now: its PIDs are the inputs of the mapping.
	byOut := map[uint16]uint16{}
	for _, m := range st.Mapping() {
		byOut[m.OutPID] = m.InPID
	}
	if byOut[256] != 2000 || byOut[257] != 2001 || byOut[258] != 2002 {
		t.Fatalf("mapping %v does not follow source B", byOut)
	}
	if len(emitted) < 400 {
		t.Fatalf("only %d packets came out", len(emitted))
	}
}
