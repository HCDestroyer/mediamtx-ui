package api

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"nodo/agent/internal/binaries"
	"nodo/agent/internal/media"
	"nodo/agent/internal/service"
	"nodo/agent/internal/supervisor"
)

func fakeRelease(t *testing.T, versions ...string) *httptest.Server {
	t.Helper()
	archives := map[string][]byte{}
	for _, v := range versions {
		var buf bytes.Buffer
		zw := gzip.NewWriter(&buf)
		tw := tar.NewWriter(zw)
		body := "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo " + v + "; exit 0; fi\necho running " + v + "\nexec sleep 30\n"
		_ = tw.WriteHeader(&tar.Header{Name: "mediamtx", Mode: 0o755, Size: int64(len(body)), Typeflag: tar.TypeReg})
		_, _ = tw.Write([]byte(body))
		_ = tw.Close()
		_ = zw.Close()
		archives[v] = buf.Bytes()
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/releases/latest", func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "/releases/tag/"+versions[len(versions)-1], http.StatusFound)
	})
	mux.HandleFunc("/releases/download/{tag}/{file}", func(w http.ResponseWriter, r *http.Request) {
		tag, file := r.PathValue("tag"), r.PathValue("file")
		archive, ok := archives[tag]
		if !ok {
			http.NotFound(w, r)
			return
		}
		asset := fmt.Sprintf("mediamtx_%s_linux_amd64.tar.gz", tag)
		if file == "checksums.sha256" {
			sum := sha256.Sum256(archive)
			fmt.Fprintf(w, "%s *%s\n", hex.EncodeToString(sum[:]), asset)
		} else if file == asset {
			_, _ = w.Write(archive)
		} else {
			http.NotFound(w, r)
		}
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return srv
}

func newBinServer(t *testing.T, release *httptest.Server) *httptest.Server {
	t.Helper()
	dir := t.TempDir()
	bins := binaries.New(filepath.Join(dir, "bin"), binaries.Options{BaseURL: release.URL, GOOS: "linux", GOARCH: "amd64"})
	ctx, cancel := context.WithCancel(context.Background())
	sup := supervisor.New(ctx, supervisor.Config{
		Binary: bins.CurrentBinary, Args: func() []string { return []string{"conf.yml"} }, Dir: dir,
		StatePath: filepath.Join(dir, "sup.json"), StopTimeout: time.Second,
	})
	mgr := service.NewManager(ctx, media.Config{}, slog.New(slog.NewTextHandler(io.Discard, nil)), nopStore{})
	srv := httptest.NewServer(New(Config{Token: token, Info: Info{Version: "test"}, Binaries: bins, Supervisor: sup, FFmpeg: "no-ffmpeg-here"}, mgr))
	t.Cleanup(func() { srv.Close(); sup.Close(); mgr.StopAll(); cancel() })
	return srv
}

func TestInstallSelectAndRunMediaMTXFromTheAPI(t *testing.T) {
	srv := newBinServer(t, fakeRelease(t, "v1.20.0", "v1.21.4"))
	auth := "Bearer " + token

	if resp, _ := do(t, srv, "GET", "/api/v1/binaries", "", ""); resp.StatusCode != 401 {
		t.Fatalf("anonymous: %d", resp.StatusCode)
	}
	_, body := do(t, srv, "GET", "/api/v1/binaries", auth, "")
	if !strings.Contains(body, `"installed":[]`) || !strings.Contains(body, `"id":"ffmpeg","found":false`) || !strings.Contains(body, `"id":"tsduck"`) {
		t.Fatalf("empty state: %s", body)
	}
	if _, body := do(t, srv, "GET", "/api/v1/binaries/mediamtx/latest", auth, ""); !strings.Contains(body, "v1.21.4") {
		t.Fatalf("latest: %s", body)
	}

	if resp, _ := do(t, srv, "POST", "/api/v1/mediamtx/process/start", auth, ""); resp.StatusCode != 409 {
		t.Fatalf("start without a version: %d", resp.StatusCode)
	}
	if resp, body := do(t, srv, "POST", "/api/v1/binaries/mediamtx/install", auth, `{"version":"latest"}`); resp.StatusCode != 200 || !strings.Contains(body, `"installed":["v1.21.4"]`) {
		t.Fatalf("install: %d %s", resp.StatusCode, body)
	}
	if resp, _ := do(t, srv, "POST", "/api/v1/binaries/mediamtx/install", auth, `{"version":"v1.20.0"}`); resp.StatusCode != 200 {
		t.Fatalf("install v1.20.0: %d", resp.StatusCode)
	}
	if resp, _ := do(t, srv, "POST", "/api/v1/binaries/mediamtx/install", auth, `{"version":"nonsense"}`); resp.StatusCode != 400 {
		t.Fatalf("bad version: %d", resp.StatusCode)
	}
	if resp, _ := do(t, srv, "POST", "/api/v1/binaries/mediamtx/install", auth, `{"version":"v9.9.9"}`); resp.StatusCode != 502 {
		t.Fatalf("unknown release: %d", resp.StatusCode)
	}
	if resp, _ := do(t, srv, "POST", "/api/v1/binaries/mediamtx/use", auth, `{"version":"v5.5.5"}`); resp.StatusCode != 404 {
		t.Fatalf("use missing: %d", resp.StatusCode)
	}
	if resp, body := do(t, srv, "POST", "/api/v1/binaries/mediamtx/use", auth, `{"version":"v1.21.4"}`); resp.StatusCode != 200 || !strings.Contains(body, `"current":"v1.21.4"`) {
		t.Fatalf("use: %d %s", resp.StatusCode, body)
	}

	if resp, body := do(t, srv, "POST", "/api/v1/mediamtx/process/start", auth, ""); resp.StatusCode != 200 || !strings.Contains(body, `"enabled":true`) {
		t.Fatalf("start: %d %s", resp.StatusCode, body)
	}
	waitFor(t, func() bool {
		_, body := do(t, srv, "GET", "/api/v1/mediamtx/process", auth, "")
		return strings.Contains(body, `"state":"running"`) && strings.Contains(body, "running v1.21.4")
	})

	// Switching versions while it runs restarts it on the new one.
	if resp, _ := do(t, srv, "POST", "/api/v1/binaries/mediamtx/use", auth, `{"version":"v1.20.0"}`); resp.StatusCode != 200 {
		t.Fatalf("switch while running: %d", resp.StatusCode)
	}
	waitFor(t, func() bool {
		_, body := do(t, srv, "GET", "/api/v1/mediamtx/process", auth, "")
		return strings.Contains(body, "running v1.20.0")
	})

	if resp, _ := do(t, srv, "DELETE", "/api/v1/binaries/mediamtx/v1.20.0", auth, ""); resp.StatusCode != 409 {
		t.Fatalf("removing the one in use: %d", resp.StatusCode)
	}
	if resp, body := do(t, srv, "DELETE", "/api/v1/binaries/mediamtx/v1.21.4", auth, ""); resp.StatusCode != 200 || strings.Contains(body, `"v1.21.4"`) {
		t.Fatalf("remove: %d %s", resp.StatusCode, body)
	}
	if resp, body := do(t, srv, "POST", "/api/v1/mediamtx/process/stop", auth, ""); resp.StatusCode != 200 || !strings.Contains(body, `"state":"stopped"`) {
		t.Fatalf("stop: %d %s", resp.StatusCode, body)
	}
	if resp, _ := do(t, srv, "POST", "/api/v1/mediamtx/process/explode", auth, ""); resp.StatusCode != 404 {
		t.Fatalf("unknown action: %d", resp.StatusCode)
	}
}

func waitFor(t *testing.T, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("timed out")
}

func TestBinariesAreOptional(t *testing.T) {
	srv := newServer(t)
	for _, path := range []string{"/api/v1/binaries", "/api/v1/mediamtx/process"} {
		if resp, _ := do(t, srv, "GET", path, "Bearer "+token, ""); resp.StatusCode != 404 {
			t.Fatalf("%s: %d", path, resp.StatusCode)
		}
	}
}
