package play

import (
	"bufio"
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"nodo/agent/internal/service"
)

func ip(s string) netip.Addr { return netip.MustParseAddr(s) }

func compile(t *testing.T, c Config) *Matcher {
	t.Helper()
	norm, err := Normalize(c)
	if err != nil {
		t.Fatal(err)
	}
	m, err := Compile(norm)
	if err != nil {
		t.Fatal(err)
	}
	return m
}

func TestRulesAreEvaluatedInOrderAndTheFirstMatchWins(t *testing.T) {
	m := compile(t, Config{
		Default: ActionDeny,
		Pools:   []Pool{{Name: "hotel", Entries: []string{"192.168.10.0/24", "10.1.1.5"}}, {Name: "bad", Entries: []string{"192.168.10.66"}}},
		Rules: []Rule{
			{Action: ActionDeny, Pool: "bad"}, // a hole in the allowed range, listed first
			{Action: ActionAllow, Pool: "hotel"},
			{Action: ActionAllow, Address: "172.16.0.0/12"},
		},
	})
	for addr, want := range map[string]bool{
		"192.168.10.20": true, "192.168.10.66": false, "10.1.1.5": true, "10.1.1.6": false,
		"172.20.1.1": true, "8.8.8.8": false, "::1": false,
	} {
		if got := m.Allowed(ip(addr)); got != want {
			t.Errorf("%s: got %v, want %v", addr, got, want)
		}
	}
}

func TestDefaultAllowWithBlockRules(t *testing.T) {
	m := compile(t, Config{Default: ActionAllow, Rules: []Rule{{Action: ActionDeny, Address: "203.0.113.0/24"}}})
	if m.Allowed(ip("203.0.113.9")) || !m.Allowed(ip("198.51.100.1")) {
		t.Fatal("block list with default allow")
	}
}

func TestIPv6AndMappedAddresses(t *testing.T) {
	m := compile(t, Config{Default: ActionDeny, Rules: []Rule{{Action: ActionAllow, Address: "2001:db8::/32"}, {Action: ActionAllow, Address: "192.0.2.7"}}})
	if !m.Allowed(ip("2001:db8::5")) || m.Allowed(ip("2001:db9::5")) {
		t.Fatal("IPv6 range")
	}
	if !m.Allowed(ip("::ffff:192.0.2.7")) {
		t.Fatal("an IPv4 client seen as a mapped IPv6 address must match its IPv4 rule")
	}
	if m.Allowed(ip("192.0.2.8")) {
		t.Fatal("neighbour matched a /32")
	}
}

func TestNormalizeRejectsBadConfigurations(t *testing.T) {
	bad := map[string]Config{
		"default":        {Default: "maybe"},
		"bad address":    {Rules: []Rule{{Action: ActionAllow, Address: "300.1.1.1"}}},
		"bad range":      {Rules: []Rule{{Action: ActionAllow, Address: "10.0.0.0/40"}}},
		"both set":       {Pools: []Pool{{Name: "a"}}, Rules: []Rule{{Action: ActionAllow, Pool: "a", Address: "1.1.1.1"}}},
		"neither set":    {Rules: []Rule{{Action: ActionAllow}}},
		"unknown pool":   {Rules: []Rule{{Action: ActionAllow, Pool: "nope"}}},
		"action":         {Rules: []Rule{{Action: "log", Address: "1.1.1.1"}}},
		"pool name":      {Pools: []Pool{{Name: "bad name"}}},
		"duplicate pool": {Pools: []Pool{{Name: "a"}, {Name: "a"}}},
		"pool entry":     {Pools: []Pool{{Name: "a", Entries: []string{"not-an-ip"}}}},
		"user name":      {Users: []User{{Name: "a b"}}},
		"duplicate user": {Users: []User{{Name: "a"}, {Name: "a"}}},
		"short token":    {Users: []User{{Name: "a", Token: "short"}}},
		"url token":      {Users: []User{{Name: "a", Token: "0123456789abcdef&x=1"}}},
		"shared token":   {Users: []User{{Name: "a", Token: "0123456789abcdef"}, {Name: "b", Token: "0123456789abcdef"}}},
		"auth no users":  {RequireAuth: true},
		"viewers":        {MaxViewers: 99999},
	}
	for name, c := range bad {
		if _, err := Normalize(c); err == nil {
			t.Errorf("%s accepted", name)
		}
	}
	tooMany := Config{}
	for i := 0; i <= maxRules; i++ {
		tooMany.Rules = append(tooMany.Rules, Rule{Action: ActionAllow, Address: "1.1.1.1"})
	}
	if _, err := Normalize(tooMany); err == nil {
		t.Error("too many rules accepted")
	}
}

func TestNormalizeFillsTokensAndTrimsEntries(t *testing.T) {
	c, err := Normalize(Config{Users: []User{{Name: "ana"}, {Name: "luis"}}, Pools: []Pool{{Name: "p", Entries: []string{" 10.0.0.1 ", "", "10.0.0.0/8"}}}})
	if err != nil {
		t.Fatal(err)
	}
	if len(c.Users[0].Token) != 32 || c.Users[0].Token == c.Users[1].Token {
		t.Fatalf("tokens %q %q", c.Users[0].Token, c.Users[1].Token)
	}
	if got := strings.Join(c.Pools[0].Entries, ","); got != "10.0.0.1,10.0.0.0/8" {
		t.Fatal(got)
	}
	if c.Default != ActionAllow || c.MaxViewers != defaultMaxViewers {
		t.Fatalf("defaults %+v", c)
	}
	again, _ := Normalize(c)
	if again.Users[0].Token != c.Users[0].Token {
		t.Fatal("an existing token must be kept")
	}
}

func TestStoreIsOffByDefaultPersistsAndRejectsWithoutChange(t *testing.T) {
	dir := t.TempDir()
	s, err := OpenStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	if s.Get().Enabled {
		t.Fatal("HTTP play must be off until turned on")
	}
	saved, err := s.Set(Config{Enabled: true, Default: ActionDeny, Rules: []Rule{{Action: ActionAllow, Address: "10.0.0.0/8"}}, Users: []User{{Name: "ana"}}})
	if err != nil {
		t.Fatal(err)
	}
	if !s.Matcher().Allowed(ip("10.1.2.3")) || s.Matcher().Allowed(ip("8.8.8.8")) {
		t.Fatal("matcher not activated")
	}
	if _, err := s.Set(Config{Enabled: true, Rules: []Rule{{Action: ActionAllow, Address: "bad"}}}); err == nil {
		t.Fatal("invalid config accepted")
	}
	if s.Get().Default != ActionDeny || len(s.Get().Rules) != 1 {
		t.Fatal("a rejected config changed the running one")
	}
	if info, err := os.Stat(filepath.Join(dir, "play.json")); err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("play.json: %v %v", err, info)
	}
	reopened, err := OpenStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	if reopened.Get().Users[0].Token != saved.Users[0].Token || !reopened.Matcher().Allowed(ip("10.9.9.9")) {
		t.Fatal("config lost after reopening")
	}
}

func TestStoreRefusesACorruptFile(t *testing.T) {
	dir := t.TempDir()
	_ = os.WriteFile(filepath.Join(dir, "play.json"), []byte("{not json"), 0o600)
	if _, err := OpenStore(dir); err == nil {
		t.Fatal("corrupt file accepted")
	}
}

// ---- HTTP ----

type fakeStreams struct {
	hub     *service.Hub
	entries []service.PlayEntry
}

func (f *fakeStreams) PlayEntries() []service.PlayEntry { return f.entries }
func (f *fakeStreams) Subscribe(id string) (*service.Subscription, error) {
	for _, e := range f.entries {
		if e.ID == id {
			if !e.Running {
				return nil, service.ErrNotRunning
			}
			sub, ok := f.hub.Subscribe()
			if !ok {
				return nil, service.ErrNotRunning
			}
			return sub, nil
		}
	}
	return nil, service.ErrNotFound
}

func setup(t *testing.T, cfg Config) (*httptest.Server, *Handler, *fakeStreams, Config) {
	t.Helper()
	store, err := OpenStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	saved, err := store.Set(cfg)
	if err != nil {
		t.Fatal(err)
	}
	fs := &fakeStreams{hub: service.NewHubForTest(), entries: []service.PlayEntry{
		{ID: "deportes-hd", Name: "Deportes HD", Running: true},
		{ID: "cine", Name: "Cine\nSecreto", Running: true},
		{ID: "parado", Name: "Parado", Running: false},
		{ID: "oculto", Name: "Oculto", Running: true, Hidden: true},
	}}
	h := NewHandler(store, fs)
	h.writeTimeout = time.Second
	mux := http.NewServeMux()
	mux.Handle("/play/", h)
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return srv, h, fs, saved
}

func get(t *testing.T, url string, header ...string) (*http.Response, string) {
	t.Helper()
	req, _ := http.NewRequest("GET", url, nil)
	for i := 0; i+1 < len(header); i += 2 {
		req.Header.Set(header[i], header[i+1])
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	return resp, string(body)
}

func TestDisabledMeansTheRouteDoesNotExist(t *testing.T) {
	srv, _, _, _ := setup(t, Config{})
	for _, p := range []string{"/play/deportes-hd", "/play/playlist.m3u"} {
		if resp, _ := get(t, srv.URL+p); resp.StatusCode != 404 {
			t.Fatalf("%s: %d", p, resp.StatusCode)
		}
	}
}

func TestStreamsTransportStreamDataToAViewerWithoutAnyOutput(t *testing.T) {
	srv, h, fs, _ := setup(t, Config{Enabled: true})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, "GET", srv.URL+"/play/deportes-hd.ts", nil)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 || resp.Header.Get("Content-Type") != "video/mp2t" {
		t.Fatalf("%d %q", resp.StatusCode, resp.Header.Get("Content-Type"))
	}
	waitFor(t, func() bool { return len(h.Clients()) == 1 })
	fs.hub.Publish([]byte("0123456789"))
	buf := make([]byte, 10)
	if _, err := io.ReadFull(bufio.NewReader(resp.Body), buf); err != nil || string(buf) != "0123456789" {
		t.Fatalf("%q %v", buf, err)
	}
	cl := h.Clients()[0]
	if cl.Service != "deportes-hd" || cl.IP != "127.0.0.1" {
		t.Fatalf("%+v", cl)
	}
	waitFor(t, func() bool { return h.Clients()[0].Bytes == 10 })
	cancel()
	waitFor(t, func() bool { return len(h.Clients()) == 0 })
	if fs.hub.Viewers() != 0 {
		t.Fatal("the viewer was not released")
	}
}

func TestViewerEndsWhenTheServiceStops(t *testing.T) {
	srv, h, fs, _ := setup(t, Config{Enabled: true})
	resp, err := http.Get(srv.URL + "/play/deportes-hd")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	waitFor(t, func() bool { return len(h.Clients()) == 1 })
	fs.hub.Shutdown()
	done := make(chan struct{})
	go func() { _, _ = io.Copy(io.Discard, resp.Body); close(done) }()
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("the response did not end when the service stopped")
	}
}

func TestUnknownHiddenAndStoppedServices(t *testing.T) {
	srv, _, _, _ := setup(t, Config{Enabled: true})
	for p, want := range map[string]int{"/play/nope": 404, "/play/oculto": 404, "/play/parado": 503, "/play/": 404} {
		if resp, _ := get(t, srv.URL+p); resp.StatusCode != want {
			t.Errorf("%s: got %d want %d", p, resp.StatusCode, want)
		}
	}
	if resp, _ := get(t, srv.URL+"/play/parado"); resp.Header.Get("Retry-After") == "" {
		t.Error("a stopped channel should say when to retry")
	}
	req, _ := http.NewRequest("POST", srv.URL+"/play/deportes-hd", nil)
	resp, _ := http.DefaultClient.Do(req)
	if resp.StatusCode != 405 {
		t.Errorf("POST: %d", resp.StatusCode)
	}
}

func TestAddressRulesBlockBeforeAnythingIsServed(t *testing.T) {
	srv, _, _, _ := setup(t, Config{Enabled: true, Default: ActionAllow, Rules: []Rule{{Action: ActionDeny, Address: "127.0.0.0/8"}}})
	for _, p := range []string{"/play/deportes-hd", "/play/playlist.m3u"} {
		if resp, _ := get(t, srv.URL+p); resp.StatusCode != 403 {
			t.Fatalf("%s: %d", p, resp.StatusCode)
		}
	}
	// An allow list with default deny lets loopback in.
	srv2, _, _, _ := setup(t, Config{Enabled: true, Default: ActionDeny, Pools: []Pool{{Name: "local", Entries: []string{"127.0.0.1"}}}, Rules: []Rule{{Action: ActionAllow, Pool: "local"}}})
	if resp, body := get(t, srv2.URL+"/play/playlist.m3u"); resp.StatusCode != 200 || !strings.Contains(body, "#EXTM3U") {
		t.Fatalf("allowed pool: %d", resp.StatusCode)
	}
}

func TestAuthenticationByTokenBearerAndBasic(t *testing.T) {
	srv, _, _, saved := setup(t, Config{Enabled: true, RequireAuth: true, Users: []User{{Name: "ana"}, {Name: "luis"}}})
	token := saved.Users[0].Token
	if resp, _ := get(t, srv.URL+"/play/playlist.m3u"); resp.StatusCode != 401 || resp.Header.Get("WWW-Authenticate") == "" {
		t.Fatalf("anonymous: %d", resp.StatusCode)
	}
	if resp, _ := get(t, srv.URL+"/play/playlist.m3u?token=wrong"); resp.StatusCode != 401 {
		t.Fatalf("wrong token: %d", resp.StatusCode)
	}
	if resp, _ := get(t, srv.URL+"/play/playlist.m3u?token="+token); resp.StatusCode != 200 {
		t.Fatalf("query token: %d", resp.StatusCode)
	}
	if resp, _ := get(t, srv.URL+"/play/playlist.m3u", "Authorization", "Bearer "+token); resp.StatusCode != 200 {
		t.Fatalf("bearer: %d", resp.StatusCode)
	}
	req, _ := http.NewRequest("GET", srv.URL+"/play/playlist.m3u", nil)
	req.SetBasicAuth("whoever", token) // players that only know user:pass@host
	resp, _ := http.DefaultClient.Do(req)
	if resp.StatusCode != 200 {
		t.Fatalf("basic: %d", resp.StatusCode)
	}
	if resp, _ := get(t, srv.URL+"/play/deportes-hd"); resp.StatusCode != 401 {
		t.Fatalf("stream without credentials: %d", resp.StatusCode)
	}
}

func TestViewersAreNamedAfterTheirUser(t *testing.T) {
	srv, h, _, saved := setup(t, Config{Enabled: true, RequireAuth: true, Users: []User{{Name: "ana"}}})
	resp, err := http.Get(srv.URL + "/play/deportes-hd?token=" + saved.Users[0].Token)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	waitFor(t, func() bool { return len(h.Clients()) == 1 })
	if h.Clients()[0].User != "ana" {
		t.Fatalf("%+v", h.Clients()[0])
	}
}

func TestPlaylistListsRunningVisibleChannelsWithTheTokenOfTheUser(t *testing.T) {
	srv, _, _, saved := setup(t, Config{Enabled: true, RequireAuth: true, Users: []User{{Name: "ana"}}})
	token := saved.Users[0].Token
	resp, body := get(t, srv.URL+"/play/playlist.m3u?token="+token)
	host := strings.TrimPrefix(srv.URL, "http://")
	if !strings.HasPrefix(body, "#EXTM3U\n") {
		t.Fatal(body)
	}
	if !strings.Contains(body, "http://"+host+"/play/deportes-hd?token="+token) {
		t.Fatalf("link with token missing:\n%s", body)
	}
	for _, absent := range []string{"parado", "oculto"} {
		if strings.Contains(body, absent) {
			t.Fatalf("%s must not be listed:\n%s", absent, body)
		}
	}
	if !strings.Contains(body, ",Cine Secreto\n") {
		t.Fatalf("a name with a line break must stay on one line:\n%s", body)
	}
	if !strings.Contains(resp.Header.Get("Content-Disposition"), "nodo.m3u") {
		t.Fatal("the playlist should download as a file")
	}
	// Without authentication the links carry no token.
	srv2, _, _, _ := setup(t, Config{Enabled: true})
	if _, open := get(t, srv2.URL+"/play/playlist.m3u"); strings.Contains(open, "token=") {
		t.Fatalf("no token expected:\n%s", open)
	}
}

func TestTooManyViewersAreRefused(t *testing.T) {
	srv, h, _, _ := setup(t, Config{Enabled: true, MaxViewers: 1})
	first, err := http.Get(srv.URL + "/play/deportes-hd")
	if err != nil {
		t.Fatal(err)
	}
	defer first.Body.Close()
	waitFor(t, func() bool { return len(h.Clients()) == 1 })
	if resp, _ := get(t, srv.URL+"/play/deportes-hd"); resp.StatusCode != 503 {
		t.Fatalf("second viewer: %d", resp.StatusCode)
	}
}

func waitFor(t *testing.T, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("timed out")
}
