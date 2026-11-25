package play

import (
	"crypto/subtle"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"nodo/agent/internal/service"
)

// Streams is what HTTP play needs from the service manager.
type Streams interface {
	Subscribe(id string) (*service.Subscription, error)
	PlayEntries() []service.PlayEntry
}

// Client is one connected viewer as the API reports it.
type Client struct {
	ID      int64  `json:"id"`
	Service string `json:"service"`
	IP      string `json:"ip"`
	User    string `json:"user,omitempty"`
	Since   int64  `json:"since"` // unix seconds
	Bytes   uint64 `json:"bytes"`
}

// viewer is the live record behind a Client; its counter is written by the streaming goroutine.
type viewer struct {
	Client
	bytes atomic.Uint64
}

// Handler serves /play/.
type Handler struct {
	store   *Store
	streams Streams
	now     func() time.Time
	// writeTimeout cuts a viewer that stops reading, instead of holding its goroutine forever.
	writeTimeout time.Duration

	mu      sync.Mutex
	clients map[int64]*viewer
	nextID  int64
}

// NewHandler wires the handler.
func NewHandler(store *Store, streams Streams) *Handler {
	return &Handler{store: store, streams: streams, now: time.Now, writeTimeout: 10 * time.Second, clients: map[int64]*viewer{}}
}

// Clients lists the connected viewers, oldest first.
func (h *Handler) Clients() []Client {
	h.mu.Lock()
	defer h.mu.Unlock()
	out := make([]Client, 0, len(h.clients))
	for _, v := range h.clients {
		c := v.Client
		c.Bytes = v.bytes.Load()
		out = append(out, c)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out
}

func clientIP(r *http.Request) (netip.Addr, bool) {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	ip, err := netip.ParseAddr(host)
	return ip.Unmap(), err == nil
}

// authenticate returns the user a request belongs to. The token may come as ?token=, as a Bearer token or
// as the password of HTTP Basic (players that only understand user:pass@host URLs).
func authenticate(r *http.Request, users []User) (string, bool) {
	var offered []string
	if t := r.URL.Query().Get("token"); t != "" {
		offered = append(offered, t)
	}
	if auth := r.Header.Get("Authorization"); auth != "" {
		if t, ok := strings.CutPrefix(auth, "Bearer "); ok {
			offered = append(offered, t)
		}
		if _, pass, ok := r.BasicAuth(); ok {
			offered = append(offered, pass)
		}
	}
	for _, t := range offered {
		for _, u := range users {
			if subtle.ConstantTimeCompare([]byte(t), []byte(u.Token)) == 1 {
				return u.Name, true
			}
		}
	}
	return "", false
}

// gate applies, in order: enabled, address rules, authentication. It answers the request itself on failure.
func (h *Handler) gate(w http.ResponseWriter, r *http.Request) (user string, token string, ok bool) {
	cfg := h.store.Get()
	if !cfg.Enabled {
		http.NotFound(w, r) // off means off: the route does not exist
		return "", "", false
	}
	ip, valid := clientIP(r)
	if !valid || !h.store.Matcher().Allowed(ip) {
		http.Error(w, "forbidden", http.StatusForbidden)
		return "", "", false
	}
	if cfg.RequireAuth {
		name, ok := authenticate(r, cfg.Users)
		if !ok {
			time.Sleep(200 * time.Millisecond) // slows down guessing
			w.Header().Set("WWW-Authenticate", `Basic realm="Nodo"`)
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return "", "", false
		}
		for _, u := range cfg.Users {
			if u.Name == name {
				return name, u.Token, true
			}
		}
	}
	return "", "", true
}

func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", "GET")
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	name := strings.TrimPrefix(r.URL.Path, "/play/")
	switch name {
	case "playlist.m3u", "playlist.m3u8":
		h.playlist(w, r)
	case "":
		http.NotFound(w, r)
	default:
		h.stream(w, r, strings.TrimSuffix(name, ".ts"))
	}
}

func (h *Handler) playlist(w http.ResponseWriter, r *http.Request) {
	user, token, ok := h.gate(w, r)
	_ = user
	if !ok {
		return
	}
	scheme := "http"
	if r.TLS != nil {
		scheme = "https"
	}
	var b strings.Builder
	b.WriteString("#EXTM3U\n")
	for _, e := range h.streams.PlayEntries() {
		if e.Hidden || !e.Running {
			continue
		}
		link := fmt.Sprintf("%s://%s/play/%s", scheme, r.Host, url.PathEscape(e.ID))
		if token != "" {
			link += "?token=" + token
		}
		fmt.Fprintf(&b, "#EXTINF:-1 tvg-id=%q group-title=\"Nodo\",%s\n%s\n", e.ID, cleanTitle(e.Name), link)
	}
	w.Header().Set("Content-Type", "audio/x-mpegurl; charset=utf-8")
	w.Header().Set("Content-Disposition", `attachment; filename="nodo.m3u"`)
	w.Header().Set("Cache-Control", "no-store")
	_, _ = w.Write([]byte(b.String()))
}

// cleanTitle keeps a name on one line, the only thing an M3U entry cannot survive.
func cleanTitle(s string) string {
	return strings.Join(strings.Fields(strings.NewReplacer("\r", " ", "\n", " ").Replace(s)), " ")
}

func (h *Handler) stream(w http.ResponseWriter, r *http.Request, id string) {
	user, _, ok := h.gate(w, r)
	if !ok {
		return
	}
	cfg := h.store.Get()
	hidden := true
	for _, e := range h.streams.PlayEntries() {
		if e.ID == id {
			hidden = e.Hidden
		}
	}
	if hidden { // unknown and hidden look the same
		http.NotFound(w, r)
		return
	}

	h.mu.Lock()
	if len(h.clients) >= cfg.MaxViewers {
		h.mu.Unlock()
		http.Error(w, "too many viewers", http.StatusServiceUnavailable)
		return
	}
	h.mu.Unlock()

	sub, err := h.streams.Subscribe(id)
	switch {
	case errors.Is(err, service.ErrNotFound):
		http.NotFound(w, r)
		return
	case err != nil:
		w.Header().Set("Retry-After", "2")
		http.Error(w, "the channel is not running", http.StatusServiceUnavailable)
		return
	}
	defer sub.Close()

	ip, _ := clientIP(r)
	c := &viewer{Client: Client{Service: id, IP: ip.String(), User: user, Since: h.now().Unix()}}
	h.mu.Lock()
	h.nextID++
	c.ID = h.nextID
	h.clients[c.ID] = c
	h.mu.Unlock()
	defer func() {
		h.mu.Lock()
		delete(h.clients, c.ID)
		h.mu.Unlock()
	}()

	w.Header().Set("Content-Type", "video/mp2t")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Accel-Buffering", "no")
	rc := http.NewResponseController(w)
	w.WriteHeader(http.StatusOK)
	_ = rc.Flush()
	for {
		select {
		case data, open := <-sub.Data:
			if !open {
				return // the service stopped, or this viewer fell too far behind
			}
			_ = rc.SetWriteDeadline(h.now().Add(h.writeTimeout))
			n, err := w.Write(data)
			c.bytes.Add(uint64(n))
			if err != nil || rc.Flush() != nil {
				return
			}
		case <-r.Context().Done():
			return
		}
	}
}
