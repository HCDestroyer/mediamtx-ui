// Package binaries installs and switches the MediaMTX binary and reports the other tools the agent
// can use (FFmpeg, TSDuck, dvblast). Every download is checked against the release's SHA-256 list and
// smoke-tested before it can be used; versions live side by side so going back is one switch.
package binaries

import (
	"archive/tar"
	"bufio"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strings"
	"sync"
	"time"
)

// DefaultBaseURL is the GitHub project that publishes the official builds.
const DefaultBaseURL = "https://github.com/bluenviron/mediamtx"

const maxBinary = 300 << 20 // a MediaMTX build is about 40 MB; anything far above is not one

var (
	versionPattern = regexp.MustCompile(`^v\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$`)

	ErrBadVersion = errors.New("the version must look like v1.21.4")
	ErrBusy       = errors.New("another install is in progress")
	ErrInUse      = errors.New("that version is the one in use; switch to another first")
	ErrNotFound   = errors.New("that version is not installed")
)

// Manager keeps <dir>/versions/<tag>/mediamtx and the <dir>/current link.
type Manager struct {
	dir     string
	baseURL string
	client  *http.Client
	goos    string
	goarch  string
	mu      sync.Mutex
	busy    bool
}

// Options configure a Manager; zero values mean production defaults.
type Options struct {
	BaseURL string
	Client  *http.Client
	GOOS    string
	GOARCH  string
}

// New creates the manager; dir is created on demand.
func New(dir string, o Options) *Manager {
	m := &Manager{dir: dir, baseURL: strings.TrimRight(o.BaseURL, "/"), client: o.Client, goos: o.GOOS, goarch: o.GOARCH}
	if m.baseURL == "" {
		m.baseURL = DefaultBaseURL
	}
	if m.client == nil {
		m.client = &http.Client{Timeout: 10 * time.Minute}
	}
	if m.goos == "" {
		m.goos = runtime.GOOS
	}
	if m.goarch == "" {
		m.goarch = runtime.GOARCH
	}
	return m
}

// assetFor names the official archive for a platform, or says why there is none.
func (m *Manager) assetFor(tag string) (string, error) {
	arch := map[string]string{"amd64": "amd64", "arm64": "arm64", "arm": "armv7"}[m.goarch]
	if m.goos != "linux" || arch == "" {
		return "", fmt.Errorf("there is no official MediaMTX build for %s/%s", m.goos, m.goarch)
	}
	return fmt.Sprintf("mediamtx_%s_linux_%s.tar.gz", tag, arch), nil
}

func (m *Manager) versionDir(tag string) string { return filepath.Join(m.dir, "versions", tag) }

// Binary is the path of the binary of an installed version.
func (m *Manager) Binary(tag string) string { return filepath.Join(m.versionDir(tag), "mediamtx") }

// Current is the version in use, or "" when none is selected.
func (m *Manager) Current() string {
	target, err := os.Readlink(filepath.Join(m.dir, "current"))
	if err != nil {
		return ""
	}
	return filepath.Base(target)
}

// CurrentBinary is the path to run, or "" when no version is selected.
func (m *Manager) CurrentBinary() string {
	tag := m.Current()
	if tag == "" {
		return ""
	}
	bin := m.Binary(tag)
	if _, err := os.Stat(bin); err != nil {
		return ""
	}
	return bin
}

// Installed lists the installed versions, newest first.
func (m *Manager) Installed() []string {
	entries, _ := os.ReadDir(filepath.Join(m.dir, "versions"))
	var tags []string
	for _, e := range entries {
		if e.IsDir() && versionPattern.MatchString(e.Name()) {
			if _, err := os.Stat(m.Binary(e.Name())); err == nil {
				tags = append(tags, e.Name())
			}
		}
	}
	sort.Slice(tags, func(i, j int) bool { return compareVersions(tags[i], tags[j]) > 0 })
	return tags
}

func compareVersions(a, b string) int {
	pa, pb := numbers(a), numbers(b)
	for i := 0; i < 3; i++ {
		if pa[i] != pb[i] {
			if pa[i] > pb[i] {
				return 1
			}
			return -1
		}
	}
	return strings.Compare(a, b)
}

func numbers(v string) [3]int {
	var out [3]int
	parts := strings.SplitN(strings.TrimPrefix(v, "v"), "-", 2)
	for i, p := range strings.SplitN(parts[0], ".", 3) {
		n := 0
		fmt.Sscanf(p, "%d", &n)
		out[i] = n
	}
	return out
}

// Latest asks GitHub for the newest release tag. It follows the /releases/latest redirect instead of the
// API, which is rate limited for anonymous callers.
func (m *Manager) Latest(ctx context.Context) (string, error) {
	noFollow := *m.client
	noFollow.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, m.baseURL+"/releases/latest", nil)
	if err != nil {
		return "", err
	}
	resp, err := noFollow.Do(req)
	if err != nil {
		return "", fmt.Errorf("could not reach the release server: %w", err)
	}
	defer resp.Body.Close()
	loc := resp.Header.Get("Location")
	tag := path.Base(loc)
	if resp.StatusCode/100 != 3 || !versionPattern.MatchString(tag) {
		return "", fmt.Errorf("the release server did not name a version (status %d)", resp.StatusCode)
	}
	return tag, nil
}

// Install downloads a version ("latest" or a tag), verifies it and makes it available. It does not
// switch to it. Installing a version that is already there is a no-op.
func (m *Manager) Install(ctx context.Context, version string) (string, error) {
	m.mu.Lock()
	if m.busy {
		m.mu.Unlock()
		return "", ErrBusy
	}
	m.busy = true
	m.mu.Unlock()
	defer func() { m.mu.Lock(); m.busy = false; m.mu.Unlock() }()

	tag := version
	if version == "latest" || version == "" {
		var err error
		if tag, err = m.Latest(ctx); err != nil {
			return "", err
		}
	}
	if !versionPattern.MatchString(tag) {
		return "", ErrBadVersion
	}
	if _, err := os.Stat(m.Binary(tag)); err == nil {
		return tag, nil
	}
	asset, err := m.assetFor(tag)
	if err != nil {
		return "", err
	}
	base := fmt.Sprintf("%s/releases/download/%s", m.baseURL, tag)

	sums, err := m.fetchText(ctx, base+"/checksums.sha256")
	if err != nil {
		return "", fmt.Errorf("could not read the checksum list: %w", err)
	}
	want, ok := findChecksum(sums, asset)
	if !ok {
		return "", fmt.Errorf("%s is not in the release's checksum list", asset)
	}

	if err := os.MkdirAll(filepath.Join(m.dir, "versions"), 0o755); err != nil {
		return "", err
	}
	staging, err := os.MkdirTemp(filepath.Join(m.dir, "versions"), ".install-*")
	if err != nil {
		return "", err
	}
	defer os.RemoveAll(staging)

	archive := filepath.Join(staging, asset)
	got, err := m.download(ctx, base+"/"+asset, archive)
	if err != nil {
		return "", err
	}
	if got != want {
		return "", fmt.Errorf("the download is corrupt or was altered: checksum %s does not match %s", got[:12], want[:12])
	}
	bin := filepath.Join(staging, "mediamtx")
	if err := extractBinary(archive, bin); err != nil {
		return "", err
	}
	if err := smokeTest(ctx, bin, tag); err != nil {
		return "", err
	}
	if err := os.MkdirAll(m.versionDir(tag), 0o755); err != nil {
		return "", err
	}
	if err := os.Rename(bin, m.Binary(tag)); err != nil {
		return "", err
	}
	return tag, nil
}

func findChecksum(list, asset string) (string, bool) {
	sc := bufio.NewScanner(strings.NewReader(list))
	for sc.Scan() {
		fields := strings.Fields(sc.Text())
		if len(fields) == 2 && strings.TrimPrefix(fields[1], "*") == asset && len(fields[0]) == 64 {
			return strings.ToLower(fields[0]), true
		}
	}
	return "", false
}

func (m *Manager) fetchText(ctx context.Context, url string) (string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return "", err
	}
	resp, err := m.client.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("status %d", resp.StatusCode)
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	return string(data), err
}

// download saves url to file and returns the SHA-256 of what was written.
func (m *Manager) download(ctx context.Context, url, file string) (string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return "", err
	}
	resp, err := m.client.Do(req)
	if err != nil {
		return "", fmt.Errorf("download failed: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("download failed: status %d", resp.StatusCode)
	}
	out, err := os.Create(file)
	if err != nil {
		return "", err
	}
	defer out.Close()
	h := sha256.New()
	n, err := io.Copy(io.MultiWriter(out, h), io.LimitReader(resp.Body, maxBinary+1))
	if err != nil {
		return "", fmt.Errorf("download failed: %w", err)
	}
	if n > maxBinary {
		return "", errors.New("the download is larger than any MediaMTX build")
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

// extractBinary copies the entry named mediamtx out of a .tar.gz, ignoring every other entry and path.
func extractBinary(archive, dest string) error {
	f, err := os.Open(archive)
	if err != nil {
		return err
	}
	defer f.Close()
	zr, err := gzip.NewReader(f)
	if err != nil {
		return fmt.Errorf("the archive is not a valid .tar.gz: %w", err)
	}
	tr := tar.NewReader(zr)
	for {
		hdr, err := tr.Next()
		if errors.Is(err, io.EOF) {
			return errors.New("the archive has no mediamtx binary")
		}
		if err != nil {
			return fmt.Errorf("the archive is damaged: %w", err)
		}
		if hdr.Typeflag != tar.TypeReg || path.Base(hdr.Name) != "mediamtx" {
			continue
		}
		out, err := os.OpenFile(dest, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o755)
		if err != nil {
			return err
		}
		n, err := io.Copy(out, io.LimitReader(tr, maxBinary+1))
		if cerr := out.Close(); err == nil {
			err = cerr
		}
		if err != nil {
			return err
		}
		if n > maxBinary {
			return errors.New("the binary inside the archive is too large")
		}
		return nil
	}
}

// smokeTest runs `mediamtx --version` and checks it reports the expected tag, so a corrupt or wrong-arch
// binary is rejected before it can replace the working one.
func smokeTest(ctx context.Context, bin, tag string) error {
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, bin, "--version").CombinedOutput()
	if err != nil {
		return fmt.Errorf("the binary does not run on this machine: %v", err)
	}
	if !strings.Contains(string(out), tag) {
		return fmt.Errorf("the binary reports %q, not %s", strings.TrimSpace(string(out)), tag)
	}
	return nil
}

// Use makes an installed version the current one. The link is replaced atomically.
func (m *Manager) Use(tag string) error {
	if !versionPattern.MatchString(tag) {
		return ErrBadVersion
	}
	if _, err := os.Stat(m.Binary(tag)); err != nil {
		return ErrNotFound
	}
	link := filepath.Join(m.dir, "current")
	tmp := link + ".new"
	_ = os.Remove(tmp)
	if err := os.Symlink(filepath.Join("versions", tag), tmp); err != nil {
		return err
	}
	return os.Rename(tmp, link)
}

// Remove deletes an installed version that is not the current one.
func (m *Manager) Remove(tag string) error {
	if !versionPattern.MatchString(tag) {
		return ErrBadVersion
	}
	if tag == m.Current() {
		return ErrInUse
	}
	if _, err := os.Stat(m.versionDir(tag)); err != nil {
		return ErrNotFound
	}
	return os.RemoveAll(m.versionDir(tag))
}
