package service

import (
	"time"

	"nodo/agent/internal/stabilizer"
	"nodo/agent/internal/ts"
)

// InputStatus describes one input of a running service.
type InputStatus struct {
	Index    int     `json:"index"`
	URL      string  `json:"url"`
	Up       bool    `json:"up"`
	Active   bool    `json:"active"`
	Kbps     float64 `json:"kbps"`
	CCErrors uint64  `json:"ccErrors"`
	// LastDataMs is how long ago the last data arrived, or -1 if none yet.
	LastDataMs int64       `json:"lastDataMs"`
	LastError  string      `json:"lastError,omitempty"`
	Program    *ts.Program `json:"program,omitempty"`
}

// OutputStatus describes one output.
type OutputStatus struct {
	Index     int    `json:"index"`
	URL       string `json:"url"`
	Up        bool   `json:"up"`
	Dropped   uint64 `json:"dropped"`
	LastError string `json:"lastError,omitempty"`
}

// Status is a snapshot of a service.
type Status struct {
	State       string                `json:"state"` // running or stopped
	ActiveInput int                   `json:"activeInput"`
	UptimeSec   int64                 `json:"uptimeSec"`
	OutKbps     float64               `json:"outKbps"`
	PMTVersion  byte                  `json:"pmtVersion"`
	Inputs      []InputStatus         `json:"inputs"`
	Mapping     []stabilizer.MapEntry `json:"mapping"`
	Outputs     []OutputStatus        `json:"outputs"`
	Events      []Event               `json:"events"`
}

// stoppedStatus is what a service that is not running reports.
func stoppedStatus(s Service) Status {
	st := Status{State: "stopped", ActiveInput: -1, Inputs: []InputStatus{}, Mapping: []stabilizer.MapEntry{}, Outputs: []OutputStatus{}, Events: []Event{}}
	for i, in := range s.Inputs {
		st.Inputs = append(st.Inputs, InputStatus{Index: i, URL: redactURL(in.URL), LastDataMs: -1})
	}
	for i, out := range s.Outputs {
		st.Outputs = append(st.Outputs, OutputStatus{Index: i, URL: redactURL(out.URL)})
	}
	return st
}

func sinceMs(t, now time.Time) int64 {
	if t.IsZero() {
		return -1
	}
	return now.Sub(t).Milliseconds()
}
