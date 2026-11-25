package service

import "sync"

// subscriberQueue is how many batches (7 packets each) a viewer may fall behind: about two seconds of a
// 5 Mbps stream. A viewer that falls further behind is dropped instead of slowing anyone down.
const subscriberQueue = 1024

// Hub fans the output of a running service out to HTTP viewers.
type Hub struct {
	mu     sync.Mutex
	subs   map[*Subscription]struct{}
	closed bool
}

// Subscription is one viewer. Data is closed when the service stops or the viewer lags too far behind.
type Subscription struct {
	Data   <-chan []byte
	ch     chan []byte
	hub    *Hub
	lagged bool
}

func newHub() *Hub { return &Hub{subs: map[*Subscription]struct{}{}} }

// Subscribe adds a viewer; ok is false when the service has already stopped.
func (h *Hub) Subscribe() (*Subscription, bool) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.closed {
		return nil, false
	}
	ch := make(chan []byte, subscriberQueue)
	s := &Subscription{Data: ch, ch: ch, hub: h}
	h.subs[s] = struct{}{}
	return s, true
}

// Close removes the viewer; safe to call more than once and after the hub closed.
func (s *Subscription) Close() {
	s.hub.mu.Lock()
	defer s.hub.mu.Unlock()
	if _, ok := s.hub.subs[s]; ok {
		delete(s.hub.subs, s)
		close(s.ch)
	}
}

// Lagged reports whether the viewer was cut for falling behind (as opposed to the service stopping).
func (s *Subscription) Lagged() bool {
	s.hub.mu.Lock()
	defer s.hub.mu.Unlock()
	return s.lagged
}

// Publish gives data to every viewer without ever blocking. data is shared: viewers must not modify it.
func (h *Hub) Publish(data []byte) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for s := range h.subs {
		select {
		case s.ch <- data:
		default:
			s.lagged = true
			delete(h.subs, s)
			close(s.ch)
		}
	}
}

// Viewers is the number of connected viewers.
func (h *Hub) Viewers() int {
	h.mu.Lock()
	defer h.mu.Unlock()
	return len(h.subs)
}

// Shutdown ends every viewer and refuses new ones.
func (h *Hub) Shutdown() {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.closed = true
	for s := range h.subs {
		delete(h.subs, s)
		close(s.ch)
	}
}

// NewHubForTest exposes a hub to other packages' tests.
func NewHubForTest() *Hub { return newHub() }
