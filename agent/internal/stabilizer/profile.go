// Package stabilizer rewrites a transport stream so its structure never changes:
// fixed PIDs and service number, regenerated PAT/PMT/SDT and its own continuity
// counters, whatever the source does.
package stabilizer

import (
	"fmt"
	"strings"

	"nodo/agent/internal/ts"
)

// Selector chooses which input stream feeds an output PID. It names a role
// (kind, language, codec) instead of a PID number, so it keeps working when the
// source renumbers its streams or reorders its languages.
type Selector struct {
	Kind  ts.Kind `json:"kind"`
	Lang  string  `json:"lang,omitempty"`
	Codec string  `json:"codec,omitempty"`
	// Index picks the Nth match (0 = first) among streams that satisfy the selector.
	Index int `json:"index,omitempty"`
	// FallbackAny allows taking the first stream of the same kind when none matches the language or codec.
	FallbackAny bool `json:"fallbackAny,omitempty"`
}

// OutStream is one PID of the output.
type OutStream struct {
	PID uint16 `json:"pid"`
	Selector
}

// Profile is the fixed structure of the output.
type Profile struct {
	ServiceID uint16 `json:"serviceId"`
	PMTPID    uint16 `json:"pmtPid"`
	Name      string `json:"name,omitempty"`
	Provider  string `json:"provider,omitempty"`
	// PCRPID is the output PID that carries the clock; 0 uses the first video PID, or the first stream.
	PCRPID  uint16      `json:"pcrPid,omitempty"`
	Streams []OutStream `json:"streams"`
	// CBRKbps pads with null packets up to a constant bitrate; 0 leaves the rate as it comes.
	CBRKbps int `json:"cbrKbps,omitempty"`
}

// Validate checks that the profile can be used.
func (p Profile) Validate() error {
	if p.ServiceID == 0 {
		return fmt.Errorf("serviceId is required")
	}
	if p.PMTPID < 0x20 || p.PMTPID > 0x1FFE {
		return fmt.Errorf("pmtPid must be between 32 and 8190")
	}
	if len(p.Streams) == 0 {
		return fmt.Errorf("at least one stream is required")
	}
	if p.CBRKbps < 0 {
		return fmt.Errorf("cbrKbps cannot be negative")
	}
	used := map[uint16]bool{p.PMTPID: true, ts.PIDPAT: true, ts.PIDSDT: true}
	for _, s := range p.Streams {
		if s.PID < 0x20 || s.PID > 0x1FFE {
			return fmt.Errorf("stream pid %d must be between 32 and 8190", s.PID)
		}
		if used[s.PID] {
			return fmt.Errorf("pid %d is used twice", s.PID)
		}
		used[s.PID] = true
		switch s.Kind {
		case ts.KindVideo, ts.KindAudio, ts.KindSubtitle, ts.KindData:
		default:
			return fmt.Errorf("stream %d: unknown kind %q", s.PID, s.Kind)
		}
		if s.Lang != "" && len(s.Lang) != 3 {
			return fmt.Errorf("stream %d: language must be a 3-letter code", s.PID)
		}
	}
	if p.PCRPID != 0 && !used[p.PCRPID] {
		// A separate PCR PID is allowed as long as it does not collide.
		used[p.PCRPID] = true
	}
	return nil
}

// match reports whether an input stream satisfies the selector (language and codec included).
func (s Selector) match(st ts.Stream) bool {
	if st.Kind != s.Kind {
		return false
	}
	if s.Lang != "" && !strings.EqualFold(st.Lang, s.Lang) {
		return false
	}
	if s.Codec != "" && !strings.EqualFold(st.Codec, s.Codec) {
		return false
	}
	return true
}

// MapState says how an output PID is being fed.
type MapState string

const (
	// StateOK: a stream matching the selector feeds the PID.
	StateOK MapState = "ok"
	// StateFallback: no exact match, the first stream of the same kind feeds it.
	StateFallback MapState = "fallback"
	// StateMissing: the input has nothing for this PID; it stays listed but sends no packets.
	StateMissing MapState = "missing"
)

// MapEntry is one line of the live mapping.
type MapEntry struct {
	OutPID uint16   `json:"outPid"`
	InPID  uint16   `json:"inPid,omitempty"`
	State  MapState `json:"state"`
	Kind   ts.Kind  `json:"kind"`
	Lang   string   `json:"lang,omitempty"`
}

// resolve assigns an input stream to every output PID of the profile.
// A stream is never used twice, so two audio selectors take two different streams.
func resolve(profile Profile, program *ts.Program) []resolved {
	out := make([]resolved, len(profile.Streams))
	taken := map[uint16]bool{}
	for i, want := range profile.Streams {
		out[i] = resolved{out: want, state: StateMissing}
		if program == nil {
			continue
		}
		if st, ok := pick(want.Selector, program.Streams, taken, true); ok {
			out[i].in, out[i].state, out[i].has = st, StateOK, true
			taken[st.PID] = true
		}
	}
	// Second pass: fallbacks only take what the exact matches left over.
	for i, want := range profile.Streams {
		if out[i].has || program == nil || !want.FallbackAny {
			continue
		}
		loose := Selector{Kind: want.Kind}
		if st, ok := pick(loose, program.Streams, taken, false); ok {
			out[i].in, out[i].state, out[i].has = st, StateFallback, true
			taken[st.PID] = true
		}
	}
	return out
}

type resolved struct {
	out   OutStream
	in    ts.Stream
	has   bool
	state MapState
}

// pick takes the Nth stream (selector.Index) that matches and is still free.
func pick(sel Selector, streams []ts.Stream, taken map[uint16]bool, honorIndex bool) (ts.Stream, bool) {
	skip := 0
	if honorIndex {
		skip = sel.Index
	}
	for _, st := range streams {
		if taken[st.PID] || !sel.match(st) {
			continue
		}
		if skip > 0 {
			skip--
			continue
		}
		return st, true
	}
	return ts.Stream{}, false
}
