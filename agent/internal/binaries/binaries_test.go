package binaries

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync/atomic"
	"testing"
)

// release builds a fake GitHub project: /releases/latest redirects, downloads serve a tarball whose
// "mediamtx" is a script printing its version, and checksums.sha256 lists it.
type release struct {
	*httptest.Server
	tamper    atomic.Bool // serve different bytes than the ones in the checksum list
	downloads atomic.Int32
	latest    string
}

func tarball(t *testing.T, files map[string]string, mode int64) []byte {
	t.Helper()
	var buf bytes.Buffer
	zw := gzip.NewWriter(&buf)
	tw := tar.NewWriter(zw)
	names := make([]string, 0, len(files))
	for name := range files {
		names = append(names, name)
	}
	sort.Strings(names) // map order is random; the checksum must not change between calls
	for _, name := range names {
		body := files[name]
		if err := tw.WriteHeader(&tar.Header{Name: name, Mode: mode, Size: int64(len(body)), Typeflag: tar.TypeReg}); err != nil {
			t.Fatal(err)
		}
		_, _ = tw.Write([]byte(body))
	}
	_ = tw.Close()
	_ = zw.Close()
	return buf.Bytes()
}

func newRelease(t *testing.T, versions map[string]string) *release {
	t.Helper()
	r := &release{latest: "v9.9.9"}
	mux := http.NewServeMux()
	mux.HandleFunc("/releases/latest", func(w http.ResponseWriter, req *http.Request) {
		http.Redirect(w, req, "/releases/tag/"+r.latest, http.StatusFound)
	})
	mux.HandleFunc("/releases/download/{tag}/{file}", func(w http.ResponseWriter, req *http.Request) {
		tag, file := req.PathValue("tag"), req.PathValue("file")
		script, ok := versions[tag]
		if !ok {
			http.NotFound(w, req)
			return
		}
		archive := tarball(t, map[string]string{"LICENSE": "x", "mediamtx.yml": "api: no", "mediamtx": script}, 0o755)
		asset := fmt.Sprintf("mediamtx_%s_linux_amd64.tar.gz", tag)
		switch file {
		case "checksums.sha256":
			sum := sha256.Sum256(archive)
			fmt.Fprintf(w, "%s *%s\n%s *%s\n", hex.EncodeToString(sum[:]), asset, strings.Repeat("0", 64), "mediamtx_"+tag+"_darwin_arm64.tar.gz")
		case asset:
			r.downloads.Add(1)
			if r.tamper.Load() {
				archive = tarball(t, map[string]string{"mediamtx": "#!/bin/sh\necho evil\n"}, 0o755)
			}
			_, _ = w.Write(archive)
		default:
			http.NotFound(w, req)
		}
	})
	r.Server = httptest.NewServer(mux)
	t.Cleanup(r.Close)
	return r
}

func script(version string) string { return "#!/bin/sh\necho " + version + "\n" }

func manager(t *testing.T, r *release) *Manager {
	t.Helper()
	return New(t.TempDir(), Options{BaseURL: r.URL, GOOS: "linux", GOARCH: "amd64"})
}

func TestLatestFollowsTheReleaseRedirect(t *testing.T) {
	r := newRelease(t, nil)
	tag, err := manager(t, r).Latest(context.Background())
	if err != nil || tag != "v9.9.9" {
		t.Fatalf("%q %v", tag, err)
	}
	r.latest = "not-a-version"
	if _, err := manager(t, r).Latest(context.Background()); err == nil {
		t.Fatal("garbage tag accepted")
	}
}

func TestInstallVerifiesExtractsAndSmokeTests(t *testing.T) {
	r := newRelease(t, map[string]string{"v9.9.9": script("v9.9.9")})
	m := manager(t, r)
	tag, err := m.Install(context.Background(), "latest")
	if err != nil || tag != "v9.9.9" {
		t.Fatalf("%q %v", tag, err)
	}
	info, err := os.Stat(m.Binary(tag))
	if err != nil || info.Mode().Perm()&0o100 == 0 {
		t.Fatalf("binary missing or not executable: %v", err)
	}
	if got := m.Installed(); len(got) != 1 || got[0] != "v9.9.9" {
		t.Fatalf("installed %v", got)
	}
	// Only the binary is kept: no license, no sample config that could be mistaken for the operator's.
	entries, _ := os.ReadDir(m.versionDir(tag))
	if len(entries) != 1 {
		t.Fatalf("version dir has %d entries", len(entries))
	}
	// Installing again does not download again.
	before := r.downloads.Load()
	if _, err := m.Install(context.Background(), "v9.9.9"); err != nil || r.downloads.Load() != before {
		t.Fatalf("second install: %v, downloads %d->%d", err, before, r.downloads.Load())
	}
}

func TestAlteredDownloadIsRejectedAndLeavesNothing(t *testing.T) {
	r := newRelease(t, map[string]string{"v9.9.9": script("v9.9.9")})
	r.tamper.Store(true)
	m := manager(t, r)
	_, err := m.Install(context.Background(), "v9.9.9")
	if err == nil || !strings.Contains(err.Error(), "checksum") {
		t.Fatalf("got %v", err)
	}
	if len(m.Installed()) != 0 {
		t.Fatal("a rejected download was installed")
	}
	entries, _ := os.ReadDir(filepath.Join(m.dir, "versions"))
	if len(entries) != 0 {
		t.Fatalf("staging left behind: %v", entries)
	}
}

func TestBinaryThatReportsAnotherVersionIsRejected(t *testing.T) {
	r := newRelease(t, map[string]string{"v1.0.0": script("v2.0.0")})
	m := manager(t, r)
	if _, err := m.Install(context.Background(), "v1.0.0"); err == nil || !strings.Contains(err.Error(), "reports") {
		t.Fatalf("got %v", err)
	}
	r2 := newRelease(t, map[string]string{"v1.0.0": "#!/bin/sh\nexit 3\n"})
	if _, err := manager(t, r2).Install(context.Background(), "v1.0.0"); err == nil {
		t.Fatal("a binary that fails to run was accepted")
	}
}

func TestVersionAndPlatformValidation(t *testing.T) {
	r := newRelease(t, nil)
	m := manager(t, r)
	for _, bad := range []string{"1.2.3", "v1.2", "../etc", "v1.2.3/../x", "latest2"} {
		if _, err := m.Install(context.Background(), bad); err == nil {
			t.Errorf("%q accepted", bad)
		}
		if m.Use(bad) == nil || m.Remove(bad) == nil {
			t.Errorf("%q accepted by Use/Remove", bad)
		}
	}
	mac := New(t.TempDir(), Options{BaseURL: r.URL, GOOS: "darwin", GOARCH: "arm64"})
	if _, err := mac.Install(context.Background(), "v1.0.0"); err == nil || !strings.Contains(err.Error(), "no official") {
		t.Fatalf("got %v", err)
	}
	if _, err := m.Install(context.Background(), "v7.7.7"); err == nil {
		t.Fatal("a version the server does not have was accepted")
	}
}

func TestSwitchingKeepsOldVersionsAndProtectsTheCurrentOne(t *testing.T) {
	r := newRelease(t, map[string]string{"v1.20.0": script("v1.20.0"), "v1.21.4": script("v1.21.4"), "v1.9.0": script("v1.9.0")})
	m := manager(t, r)
	for _, v := range []string{"v1.20.0", "v1.21.4", "v1.9.0"} {
		if _, err := m.Install(context.Background(), v); err != nil {
			t.Fatal(err)
		}
	}
	if got := m.Installed(); strings.Join(got, ",") != "v1.21.4,v1.20.0,v1.9.0" {
		t.Fatalf("numeric order expected, got %v", got)
	}
	if m.Current() != "" || m.CurrentBinary() != "" {
		t.Fatal("nothing selected yet")
	}
	if err := m.Use("v1.21.4"); err != nil {
		t.Fatal(err)
	}
	if m.Current() != "v1.21.4" || !strings.HasSuffix(m.CurrentBinary(), "v1.21.4/mediamtx") {
		t.Fatalf("current %q %q", m.Current(), m.CurrentBinary())
	}
	if err := m.Use("v1.20.0"); err != nil || m.Current() != "v1.20.0" {
		t.Fatalf("switch back: %v %q", err, m.Current())
	}
	if err := m.Remove("v1.20.0"); err != ErrInUse {
		t.Fatalf("removing the current one: %v", err)
	}
	if err := m.Remove("v1.9.0"); err != nil {
		t.Fatal(err)
	}
	if err := m.Remove("v1.9.0"); err != ErrNotFound {
		t.Fatalf("got %v", err)
	}
	if err := m.Use("v5.5.5"); err != ErrNotFound {
		t.Fatalf("got %v", err)
	}
}

func TestExtractIgnoresEverythingButTheBinaryAndPaths(t *testing.T) {
	dir := t.TempDir()
	archive := filepath.Join(dir, "a.tar.gz")
	_ = os.WriteFile(archive, tarball(t, map[string]string{"../../escape": "x", "sub/mediamtx": "real"}, 0o644), 0o644)
	dest := filepath.Join(dir, "out")
	if err := extractBinary(archive, dest); err != nil {
		t.Fatal(err)
	}
	if data, _ := os.ReadFile(dest); string(data) != "real" {
		t.Fatalf("%q", data)
	}
	if _, err := os.Stat(filepath.Join(dir, "..", "escape")); err == nil {
		t.Fatal("path traversal")
	}
	_ = os.WriteFile(archive, tarball(t, map[string]string{"LICENSE": "x"}, 0o644), 0o644)
	if err := extractBinary(archive, dest); err == nil {
		t.Fatal("archive without the binary accepted")
	}
	_ = os.WriteFile(archive, []byte("not gzip"), 0o644)
	if err := extractBinary(archive, dest); err == nil {
		t.Fatal("garbage accepted")
	}
}

func TestConcurrentInstallIsRefused(t *testing.T) {
	r := newRelease(t, map[string]string{"v1.0.0": script("v1.0.0")})
	m := manager(t, r)
	m.mu.Lock()
	m.busy = true
	m.mu.Unlock()
	if _, err := m.Install(context.Background(), "v1.0.0"); err != ErrBusy {
		t.Fatalf("got %v", err)
	}
}

func TestToolsReportMissingProgramsWithoutFailing(t *testing.T) {
	tools := Tools("definitely-not-installed-ffmpeg")
	if len(tools) != 3 {
		t.Fatalf("%v", tools)
	}
	if tools[0].ID != "ffmpeg" || tools[0].Found {
		t.Fatalf("%+v", tools[0])
	}
	fake := filepath.Join(t.TempDir(), "ffmpeg")
	_ = os.WriteFile(fake, []byte("#!/bin/sh\necho 'ffmpeg version 9.9'\necho second line\n"), 0o755)
	if got := Tools(fake)[0]; !got.Found || got.Version != "ffmpeg version 9.9" {
		t.Fatalf("%+v", got)
	}
}
