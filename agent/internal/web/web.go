// Package web serves the Nodo panel embedded in the agent binary, the way Astra serves its own interface.
// The built files under dist/ are committed (scripts/build-agent.sh refreshes them), so a plain
// `go build` already produces the full installable.
package web

import (
	"bytes"
	"compress/gzip"
	"embed"
	"io/fs"
	"mime"
	"net/http"
	"path"
	"strconv"
	"strings"
	"time"
)

//go:embed all:dist
var embedded embed.FS

// Handler serves the panel embedded in the binary.
func Handler() http.Handler {
	sub, err := fs.Sub(embedded, "dist")
	if err != nil {
		panic(err) // the directory is part of the embed pattern
	}
	return NewHandler(sub)
}

type asset struct {
	body    []byte
	gzipped []byte // nil when compression does not pay off
	ctype   string
	etag    string
}

type handler struct {
	assets  map[string]*asset
	started time.Time
}

// NewHandler serves a built panel from files. Requests for paths that are not a file fall back to
// index.html so client-side routes survive a reload; paths with an extension that do not exist are 404.
func NewHandler(files fs.FS) http.Handler {
	h := &handler{assets: map[string]*asset{}, started: time.Now()}
	_ = fs.WalkDir(files, ".", func(name string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return nil
		}
		body, err := fs.ReadFile(files, name)
		if err != nil {
			return nil
		}
		a := &asset{body: body, ctype: contentType(name), etag: etagOf(body)}
		if compressible(a.ctype) && len(body) > 512 {
			var buf bytes.Buffer
			zw, _ := gzip.NewWriterLevel(&buf, gzip.BestCompression)
			_, _ = zw.Write(body)
			_ = zw.Close()
			if buf.Len() < len(body) {
				a.gzipped = buf.Bytes()
			}
		}
		h.assets[name] = a
		return nil
	})
	return h
}

func (h *handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		w.Header().Set("Allow", "GET, HEAD")
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	name := strings.TrimPrefix(path.Clean("/"+r.URL.Path), "/")
	if name == "" {
		name = "index.html"
	}
	a := h.assets[name]
	if a == nil {
		if path.Ext(name) != "" {
			http.NotFound(w, r)
			return
		}
		name = "index.html" // client-side route
		a = h.assets[name]
	}
	if a == nil {
		http.NotFound(w, r)
		return
	}

	hdr := w.Header()
	hdr.Set("Content-Type", a.ctype)
	hdr.Set("ETag", a.etag)
	hdr.Set("X-Content-Type-Options", "nosniff")
	// Vite names files under assets/ with a content hash; everything else must be revalidated.
	if strings.HasPrefix(name, "assets/") {
		hdr.Set("Cache-Control", "public, max-age=31536000, immutable")
	} else {
		hdr.Set("Cache-Control", "no-cache")
	}
	if match := r.Header.Get("If-None-Match"); match == a.etag {
		w.WriteHeader(http.StatusNotModified)
		return
	}
	body := a.body
	if a.gzipped != nil {
		hdr.Add("Vary", "Accept-Encoding")
		if acceptsGzip(r) {
			hdr.Set("Content-Encoding", "gzip")
			body = a.gzipped
		}
	}
	hdr.Set("Content-Length", strconv.Itoa(len(body)))
	if r.Method == http.MethodGet {
		_, _ = w.Write(body)
	}
}

func acceptsGzip(r *http.Request) bool {
	for _, part := range strings.Split(r.Header.Get("Accept-Encoding"), ",") {
		coding, params, _ := strings.Cut(strings.TrimSpace(part), ";")
		if strings.EqualFold(strings.TrimSpace(coding), "gzip") {
			return !strings.Contains(strings.ReplaceAll(params, " ", ""), "q=0") || strings.Contains(params, "q=0.")
		}
	}
	return false
}

func contentType(name string) string {
	switch strings.ToLower(path.Ext(name)) {
	case ".js", ".mjs":
		return "text/javascript; charset=utf-8"
	case ".css":
		return "text/css; charset=utf-8"
	case ".html":
		return "text/html; charset=utf-8"
	case ".json", ".webmanifest":
		return "application/json; charset=utf-8"
	case ".svg":
		return "image/svg+xml"
	}
	if t := mime.TypeByExtension(path.Ext(name)); t != "" {
		return t
	}
	return "application/octet-stream"
}

func compressible(ctype string) bool {
	return strings.HasPrefix(ctype, "text/") || strings.Contains(ctype, "json") || strings.Contains(ctype, "svg")
}

func etagOf(body []byte) string {
	// FNV-1a: cheap and enough to tell versions apart.
	h := uint64(14695981039346656037)
	for _, b := range body {
		h ^= uint64(b)
		h *= 1099511628211
	}
	return `"` + strconv.FormatUint(h, 16) + `"`
}
