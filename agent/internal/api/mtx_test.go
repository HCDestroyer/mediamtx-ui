package api

import (
	"context"
	"io"
	"log/slog"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"nodo/agent/internal/media"
	"nodo/agent/internal/mtxconf"
	"nodo/agent/internal/service"
)

func newMTXServer(t *testing.T) (*httptest.Server, string) {
	t.Helper()
	dir := t.TempDir()
	base := filepath.Join(dir, "mediamtx.yml")
	if err := os.WriteFile(base, []byte("api: yes\npaths:\n  canal63:\n    source: publisher\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	reject := func(path string) error {
		data, _ := os.ReadFile(path)
		if strings.Contains(string(data), "badParam") {
			return &mtxconf.InvalidError{Message: "unknown parameter badParam"}
		}
		return nil
	}
	mgr, err := mtxconf.New(mtxconf.Paths{Base: base, Overlay: filepath.Join(dir, "n", "overlay.yml"), Out: filepath.Join(dir, "n", "mediamtx.yml")}, reject)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	svc := service.NewManager(ctx, media.Config{}, slog.New(slog.NewTextHandler(io.Discard, nil)), nopStore{})
	srv := httptest.NewServer(New(Config{Token: token, Info: Info{Version: "test"}, MediaMTX: mgr}, svc))
	t.Cleanup(func() { srv.Close(); svc.StopAll(); cancel() })
	return srv, filepath.Join(dir, "n", "mediamtx.yml")
}

func TestMediaMTXConfigNeedsAuthAndIsOptional(t *testing.T) {
	srv, _ := newMTXServer(t)
	if resp, _ := do(t, srv, "GET", "/api/v1/mediamtx/config", "", ""); resp.StatusCode != 401 {
		t.Fatalf("anonymous: %d", resp.StatusCode)
	}
	if resp, _ := do(t, newServer(t), "GET", "/api/v1/mediamtx/config", "Bearer "+token, ""); resp.StatusCode != 404 {
		t.Fatalf("disabled feature: %d", resp.StatusCode)
	}
}

func TestValidateApplyAndUndoOverHTTP(t *testing.T) {
	srv, out := newMTXServer(t)
	auth := "Bearer " + token

	_, body := do(t, srv, "POST", "/api/v1/mediamtx/validate", auth, `{"overlay":"srtPassphrase: hunter2hunter2\npaths:\n  nuevo:\n    source: publisher\n"}`)
	if !strings.Contains(body, `"ok":true`) || strings.Contains(body, "hunter2") || !strings.Contains(body, "canal63") {
		t.Fatalf("validate: %s", body)
	}
	if _, err := os.Stat(out); err == nil {
		t.Fatal("validate must not write")
	}

	_, body = do(t, srv, "POST", "/api/v1/mediamtx/validate", auth, `{"overlay":"badParam: 1\n"}`)
	if !strings.Contains(body, `"ok":false`) || !strings.Contains(body, "badParam") {
		t.Fatalf("invalid validate: %s", body)
	}

	if resp, body := do(t, srv, "PUT", "/api/v1/mediamtx/config", auth, `{"overlay":"badParam: 1\n"}`); resp.StatusCode != 422 || !strings.Contains(body, "badParam") {
		t.Fatalf("invalid apply: %d %s", resp.StatusCode, body)
	}
	if _, err := os.Stat(out); err == nil {
		t.Fatal("a rejected configuration was written")
	}

	resp, body := do(t, srv, "PUT", "/api/v1/mediamtx/config", auth, `{"overlay":"logLevel: info\n"}`)
	if resp.StatusCode != 200 || !strings.Contains(body, `"outFound":true`) {
		t.Fatalf("apply: %d %s", resp.StatusCode, body)
	}
	do(t, srv, "PUT", "/api/v1/mediamtx/config", auth, `{"overlay":"logLevel: debug\n"}`)
	if data, _ := os.ReadFile(out); !strings.Contains(string(data), "logLevel: debug") || !strings.Contains(string(data), "api: yes") {
		t.Fatalf("merged file: %s", data)
	}
	if resp, body := do(t, srv, "POST", "/api/v1/mediamtx/undo", auth, ""); resp.StatusCode != 200 || !strings.Contains(body, "info") {
		t.Fatalf("undo: %d %s", resp.StatusCode, body)
	}
	if resp, _ := do(t, srv, "POST", "/api/v1/mediamtx/undo", auth, ""); resp.StatusCode != 409 {
		t.Fatalf("nothing left to undo: %d", resp.StatusCode)
	}
}
