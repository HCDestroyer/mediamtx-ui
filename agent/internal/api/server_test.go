package api

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"nodo/agent/internal/media"
	"nodo/agent/internal/service"
)

type nopStore struct{}

func (nopStore) Save([]service.Service) error { return nil }

const token = "test-token-0123456789"

func newServer(t *testing.T, origins ...string) *httptest.Server {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	mgr := service.NewManager(ctx, media.Config{}, slog.New(slog.NewTextHandler(io.Discard, nil)), nopStore{})
	srv := httptest.NewServer(New(Config{Token: token, AllowOrigins: origins, Info: Info{Version: "test"}}, mgr))
	t.Cleanup(func() { srv.Close(); mgr.StopAll(); cancel() })
	return srv
}

func do(t *testing.T, srv *httptest.Server, method, path, auth, body string) (*http.Response, string) {
	t.Helper()
	req, _ := http.NewRequest(method, srv.URL+path, bytes.NewBufferString(body))
	if auth != "" {
		req.Header.Set("Authorization", auth)
	}
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(resp.Body)
	return resp, string(data)
}

const goodService = `{
  "name": "Deportes HD", "enabled": false,
  "inputs": [{"url": "udp://127.0.0.1:41001#pnr=100"}],
  "outputs": [{"url": "udp://127.0.0.1:41002"}],
  "profile": {"serviceId": 100, "pmtPid": 4096, "streams": [
    {"pid": 256, "kind": "video"}, {"pid": 257, "kind": "audio", "lang": "spa", "fallbackAny": true}]}
}`

func TestAuthentication(t *testing.T) {
	srv := newServer(t)
	for name, auth := range map[string]string{"none": "", "wrong": "Bearer nope", "basic": "Basic dXNlcjpwYXNz", "empty": "Bearer "} {
		if resp, _ := do(t, srv, "GET", "/api/v1/services", auth, ""); resp.StatusCode != http.StatusUnauthorized {
			t.Errorf("%s: status %d, want 401", name, resp.StatusCode)
		}
	}
	if resp, _ := do(t, srv, "GET", "/api/v1/services", "Bearer "+token, ""); resp.StatusCode != http.StatusOK {
		t.Fatalf("right token: %d", resp.StatusCode)
	}
	if resp, body := do(t, srv, "GET", "/healthz", "", ""); resp.StatusCode != 200 || body != "ok" {
		t.Fatal("healthz must work without a token")
	}
}

func TestCRUDFlow(t *testing.T) {
	srv := newServer(t)
	auth := "Bearer " + token

	resp, body := do(t, srv, "POST", "/api/v1/services", auth, goodService)
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("create: %d %s", resp.StatusCode, body)
	}
	var created service.View
	if err := json.Unmarshal([]byte(body), &created); err != nil {
		t.Fatal(err)
	}
	if created.Service.ID != "deportes-hd" || created.Status.State != "stopped" || created.Service.Backup.Mode != "active" || created.Service.Profile.Name != "Deportes HD" {
		t.Fatalf("id derived from the name and defaults applied: %+v", created.Service)
	}

	if resp, _ := do(t, srv, "POST", "/api/v1/services", auth, goodService); resp.StatusCode != http.StatusConflict {
		t.Fatalf("duplicate: %d", resp.StatusCode)
	}
	if resp, _ := do(t, srv, "GET", "/api/v1/services/deportes-hd", auth, ""); resp.StatusCode != 200 {
		t.Fatal("get")
	}
	if resp, _ := do(t, srv, "GET", "/api/v1/services/nope", auth, ""); resp.StatusCode != 404 {
		t.Fatal("get unknown")
	}

	// enable starts it, status says so
	resp, body = do(t, srv, "POST", "/api/v1/services/deportes-hd/enable", auth, "")
	var enabled service.View
	_ = json.Unmarshal([]byte(body), &enabled)
	if resp.StatusCode != 200 || enabled.Status.State != "running" || len(enabled.Status.Mapping) != 2 {
		t.Fatalf("enable: %d %s", resp.StatusCode, body)
	}

	// PUT with a hot profile change
	updated := strings.Replace(goodService, `"pid": 257`, `"pid": 300`, 1)
	updated = strings.Replace(updated, `"enabled": false`, `"enabled": true`, 1)
	resp, body = do(t, srv, "PUT", "/api/v1/services/deportes-hd", auth, updated)
	if resp.StatusCode != 200 || !strings.Contains(body, `"outPid":300`) {
		t.Fatalf("update: %d %s", resp.StatusCode, body)
	}
	if resp, _ := do(t, srv, "PUT", "/api/v1/services/deportes-hd", auth, strings.Replace(updated, `"name"`, `"id": "otro", "name"`, 1)); resp.StatusCode != 400 {
		t.Fatalf("changing the id must be rejected, got %d", resp.StatusCode)
	}

	resp, body = do(t, srv, "POST", "/api/v1/services/deportes-hd/switch", auth, `{"input": 7}`)
	if resp.StatusCode != 400 {
		t.Fatalf("switch to a missing input: %d %s", resp.StatusCode, body)
	}
	if resp, _ := do(t, srv, "POST", "/api/v1/services/deportes-hd/switch", auth, `{}`); resp.StatusCode != 400 {
		t.Fatal("switch without input")
	}

	if resp, _ := do(t, srv, "DELETE", "/api/v1/services/deportes-hd", auth, ""); resp.StatusCode != 204 {
		t.Fatal("delete")
	}
	if resp, _ := do(t, srv, "DELETE", "/api/v1/services/deportes-hd", auth, ""); resp.StatusCode != 404 {
		t.Fatal("delete twice")
	}
	if _, body := do(t, srv, "GET", "/api/v1/services", auth, ""); strings.TrimSpace(body) != "[]" {
		t.Fatalf("list after delete: %s", body)
	}
}

func TestValidationErrorsReachTheCaller(t *testing.T) {
	srv := newServer(t)
	auth := "Bearer " + token
	cases := map[string]string{
		"bad json":      `{`,
		"unknown field": `{"name":"x","nope":1}`,
		"bad input":     strings.Replace(goodService, "udp://127.0.0.1:41001#pnr=100", "nonsense", 1),
		"output cbr":    strings.Replace(goodService, "udp://127.0.0.1:41002", "udp://127.0.0.1:41002#cbr=4000", 1),
		"duplicate pid": strings.Replace(goodService, `"pid": 257`, `"pid": 256`, 1),
		"service id":    strings.Replace(goodService, `"serviceId": 100`, `"serviceId": 0`, 1),
	}
	for name, body := range cases {
		resp, got := do(t, srv, "POST", "/api/v1/services", auth, body)
		if resp.StatusCode != http.StatusBadRequest {
			t.Errorf("%s: status %d", name, resp.StatusCode)
			continue
		}
		var e struct{ Error string }
		if json.Unmarshal([]byte(got), &e) != nil || e.Error == "" {
			t.Errorf("%s: the error must say what is wrong: %s", name, got)
		}
	}
}

func TestSecretsAreNotReturned(t *testing.T) {
	srv := newServer(t)
	auth := "Bearer " + token
	body := strings.Replace(goodService, "udp://127.0.0.1:41002", "rtmps://a.example/live2#key=abcd-SECRET", 1)
	resp, got := do(t, srv, "POST", "/api/v1/services", auth, body)
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("%d %s", resp.StatusCode, got)
	}
	var v service.View
	_ = json.Unmarshal([]byte(got), &v)
	if strings.Contains(v.Status.Outputs[0].URL, "SECRET") {
		t.Fatalf("the status must not expose stream keys: %s", v.Status.Outputs[0].URL)
	}
}

func TestCORS(t *testing.T) {
	srv := newServer(t, "https://panel.example")
	req, _ := http.NewRequest("OPTIONS", srv.URL+"/api/v1/services", nil)
	req.Header.Set("Origin", "https://panel.example")
	resp, _ := http.DefaultClient.Do(req)
	if resp.StatusCode != 204 || resp.Header.Get("Access-Control-Allow-Origin") != "https://panel.example" || !strings.Contains(resp.Header.Get("Access-Control-Allow-Headers"), "Authorization") {
		t.Fatalf("preflight: %d %v", resp.StatusCode, resp.Header)
	}
	req, _ = http.NewRequest("OPTIONS", srv.URL+"/api/v1/services", nil)
	req.Header.Set("Origin", "https://evil.example")
	resp, _ = http.DefaultClient.Do(req)
	if resp.Header.Get("Access-Control-Allow-Origin") != "" {
		t.Fatal("an origin that is not allowed must get no CORS headers")
	}
	any := newServer(t, "*")
	req, _ = http.NewRequest("GET", any.URL+"/healthz", nil)
	req.Header.Set("Origin", "http://192.168.1.5:5173")
	resp, _ = http.DefaultClient.Do(req)
	if resp.Header.Get("Access-Control-Allow-Origin") != "*" {
		t.Fatal("wildcard origin")
	}
}

func TestSlug(t *testing.T) {
	for in, want := range map[string]string{"Deportes HD": "deportes-hd", "  Canal 63 / Cesbo ": "canal-63-cesbo", "ÑANDÚ": "and", "---": ""} {
		if got := slug(in); got != want {
			t.Errorf("slug(%q) = %q, want %q", in, got, want)
		}
	}
}

func newServerWithPanel(t *testing.T) *httptest.Server {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	mgr := service.NewManager(ctx, media.Config{}, slog.New(slog.NewTextHandler(io.Discard, nil)), nopStore{})
	panel := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { _, _ = io.WriteString(w, "PANEL") })
	srv := httptest.NewServer(New(Config{Token: token, Info: Info{Version: "test"}, Panel: panel}, mgr))
	t.Cleanup(func() { srv.Close(); mgr.StopAll(); cancel() })
	return srv
}

func TestPanelIsServedAtRootAndTheAPIStaysProtected(t *testing.T) {
	srv := newServerWithPanel(t)
	if _, body := do(t, srv, "GET", "/", "", ""); body != "PANEL" {
		t.Fatalf("root: %q", body)
	}
	if _, body := do(t, srv, "GET", "/services", "", ""); body != "PANEL" {
		t.Fatalf("client route: %q", body)
	}
	if resp, _ := do(t, srv, "GET", "/api/v1/services", "", ""); resp.StatusCode != 401 {
		t.Fatalf("API without token: %d", resp.StatusCode)
	}
	resp, body := do(t, srv, "GET", "/api/v1/nope", "Bearer "+token, "")
	if resp.StatusCode != 404 || strings.Contains(body, "PANEL") {
		t.Fatalf("unknown API path must be a JSON 404, got %d %q", resp.StatusCode, body)
	}
	if resp, _ := do(t, srv, "GET", "/healthz", "", ""); resp.StatusCode != 200 {
		t.Fatalf("healthz: %d", resp.StatusCode)
	}
}

func TestWithoutPanelRootIs404(t *testing.T) {
	if resp, _ := do(t, newServer(t), "GET", "/", "", ""); resp.StatusCode != 404 {
		t.Fatalf("got %d", resp.StatusCode)
	}
}
