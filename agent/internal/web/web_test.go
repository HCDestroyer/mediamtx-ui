package web

import (
	"compress/gzip"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"
)

func site() http.Handler {
	return NewHandler(fstest.MapFS{
		"index.html":         {Data: []byte("<!doctype html><title>Nodo</title>" + strings.Repeat("x", 1000))},
		"assets/app-1a2b.js": {Data: []byte(strings.Repeat("console.log(1);", 100))},
		"icon.png":           {Data: []byte{0x89, 'P', 'N', 'G'}},
	})
}

func get(h http.Handler, target string, headers map[string]string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodGet, target, nil)
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func TestServesIndexAtRootAndForClientRoutes(t *testing.T) {
	for _, target := range []string{"/", "/index.html", "/channels/canal63", "/services"} {
		rec := get(site(), target, nil)
		if rec.Code != 200 || !strings.Contains(rec.Body.String(), "<title>Nodo</title>") {
			t.Errorf("%s: code %d", target, rec.Code)
		}
		if cc := rec.Header().Get("Cache-Control"); cc != "no-cache" {
			t.Errorf("%s: index must be revalidated, got %q", target, cc)
		}
	}
}

func TestMissingFileWithExtensionIs404(t *testing.T) {
	if rec := get(site(), "/assets/missing.js", nil); rec.Code != 404 {
		t.Fatalf("code %d", rec.Code)
	}
}

func TestHashedAssetsAreImmutableWithTheRightType(t *testing.T) {
	rec := get(site(), "/assets/app-1a2b.js", nil)
	if rec.Code != 200 || !strings.Contains(rec.Header().Get("Cache-Control"), "immutable") {
		t.Fatalf("code %d cache %q", rec.Code, rec.Header().Get("Cache-Control"))
	}
	if ct := rec.Header().Get("Content-Type"); !strings.HasPrefix(ct, "text/javascript") {
		t.Fatalf("content type %q", ct)
	}
}

func TestGzipOnlyWhenAccepted(t *testing.T) {
	plain := get(site(), "/assets/app-1a2b.js", nil)
	if plain.Header().Get("Content-Encoding") != "" {
		t.Fatal("must not compress without Accept-Encoding")
	}
	zipped := get(site(), "/assets/app-1a2b.js", map[string]string{"Accept-Encoding": "br, gzip"})
	if zipped.Header().Get("Content-Encoding") != "gzip" {
		t.Fatal("expected gzip")
	}
	zr, err := gzip.NewReader(zipped.Body)
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(zr)
	if string(body) != plain.Body.String() {
		t.Fatal("decompressed body differs")
	}
	refused := get(site(), "/assets/app-1a2b.js", map[string]string{"Accept-Encoding": "gzip;q=0"})
	if refused.Header().Get("Content-Encoding") != "" {
		t.Fatal("gzip;q=0 means refused")
	}
	if get(site(), "/icon.png", map[string]string{"Accept-Encoding": "gzip"}).Header().Get("Content-Encoding") != "" {
		t.Fatal("binary files are not compressed")
	}
}

func TestConditionalRequest(t *testing.T) {
	first := get(site(), "/", nil)
	again := get(site(), "/", map[string]string{"If-None-Match": first.Header().Get("ETag")})
	if again.Code != http.StatusNotModified || again.Body.Len() != 0 {
		t.Fatalf("code %d", again.Code)
	}
}

func TestRejectsWrites(t *testing.T) {
	rec := httptest.NewRecorder()
	site().ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/", nil))
	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("code %d", rec.Code)
	}
}

func TestPathTraversalStaysInside(t *testing.T) {
	rec := get(site(), "/../../etc/passwd", nil)
	if strings.Contains(rec.Body.String(), "root:") {
		t.Fatal("escaped the root")
	}
}

func TestEmbeddedPlaceholderBuilds(t *testing.T) {
	rec := get(Handler(), "/", nil)
	if rec.Code != 200 || !strings.Contains(rec.Body.String(), "nodo-agent") {
		t.Fatalf("code %d", rec.Code)
	}
}
