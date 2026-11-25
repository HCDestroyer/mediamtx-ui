package service

import "time"

// Event is a line of the service log shown in the panel.
type Event struct {
	At      time.Time `json:"at"`
	Level   string    `json:"level"` // info, warn, error
	Message string    `json:"message"`
}

// ring keeps the most recent events. Only the service loop touches it.
type ring struct {
	items []Event
	max   int
}

func newRing(max int) *ring { return &ring{max: max} }

func (r *ring) add(e Event) {
	r.items = append(r.items, e)
	if len(r.items) > r.max {
		r.items = r.items[len(r.items)-r.max:]
	}
}

// list returns the events newest first.
func (r *ring) list() []Event {
	out := make([]Event, len(r.items))
	for i, e := range r.items {
		out[len(r.items)-1-i] = e
	}
	return out
}
