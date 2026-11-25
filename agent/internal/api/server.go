// Package api serves the agent's HTTP API: JSON over HTTP with a bearer token.
package api

import (
	"crypto/subtle"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"regexp"
	"strings"
	"time"

	"nodo/agent/internal/service"
)

// Info is shown by GET /api/v1/info.
type Info struct {
	Version   string `json:"version"`
	FFmpeg    string `json:"ffmpeg"` // version line, empty when not found
	MediaMTX  bool   `json:"mediamtx"`
	StartedAt int64  `json:"startedAt"`
}

// Config wires the server.
type Config struct {
	Token string
	// AllowOrigins lists the origins allowed by CORS; "*" allows any (the token is in a header, not a cookie).
	AllowOrigins []string
	Info         Info
	// Panel serves the web interface at "/" (embedded in the binary); nil serves the API only.
	Panel http.Handler
}

// Server holds the routes.
type Server struct {
	cfg Config
	mgr *service.Manager
	mux *http.ServeMux
}

const maxBody = 1 << 20

// New creates the handler tree.
func New(cfg Config, mgr *service.Manager) http.Handler {
	s := &Server{cfg: cfg, mgr: mgr, mux: http.NewServeMux()}
	s.mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) { _, _ = io.WriteString(w, "ok") })
	s.mux.HandleFunc("GET /api/v1/info", s.auth(s.info))
	s.mux.HandleFunc("GET /api/v1/services", s.auth(s.list))
	s.mux.HandleFunc("POST /api/v1/services", s.auth(s.create))
	s.mux.HandleFunc("GET /api/v1/services/{id}", s.auth(s.get))
	s.mux.HandleFunc("PUT /api/v1/services/{id}", s.auth(s.update))
	s.mux.HandleFunc("DELETE /api/v1/services/{id}", s.auth(s.remove))
	s.mux.HandleFunc("POST /api/v1/services/{id}/enable", s.auth(s.setEnabled(true)))
	s.mux.HandleFunc("POST /api/v1/services/{id}/disable", s.auth(s.setEnabled(false)))
	s.mux.HandleFunc("POST /api/v1/services/{id}/switch", s.auth(s.switchInput))
	// Unknown API paths answer JSON, never the panel's index.html.
	s.mux.HandleFunc("/api/", func(w http.ResponseWriter, _ *http.Request) { writeError(w, http.StatusNotFound, "not found") })
	if cfg.Panel != nil {
		s.mux.Handle("/", cfg.Panel)
	}
	return s.cors(s.mux)
}

// ---- middleware ----

func (s *Server) cors(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")
		if origin != "" && s.originAllowed(origin) {
			h := w.Header()
			if len(s.cfg.AllowOrigins) == 1 && s.cfg.AllowOrigins[0] == "*" {
				h.Set("Access-Control-Allow-Origin", "*")
			} else {
				h.Set("Access-Control-Allow-Origin", origin)
				h.Add("Vary", "Origin")
			}
			h.Set("Access-Control-Allow-Headers", "Authorization, Content-Type")
			h.Set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
			h.Set("Access-Control-Max-Age", "600")
		}
		if r.Method == http.MethodOptions { // preflight carries no credentials
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func (s *Server) originAllowed(origin string) bool {
	for _, o := range s.cfg.AllowOrigins {
		if o == "*" || strings.EqualFold(o, origin) {
			return true
		}
	}
	return false
}

func (s *Server) auth(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		got, ok := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
		if !ok || s.cfg.Token == "" || subtle.ConstantTimeCompare([]byte(got), []byte(s.cfg.Token)) != 1 {
			time.Sleep(200 * time.Millisecond) // slows down guessing
			writeError(w, http.StatusUnauthorized, "missing or wrong token")
			return
		}
		next(w, r)
	}
}

// ---- helpers ----

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}

func decodeService(w http.ResponseWriter, r *http.Request) (service.Service, bool) {
	var svc service.Service
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxBody))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&svc); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON: "+err.Error())
		return svc, false
	}
	return svc, true
}

func failure(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, service.ErrNotFound):
		writeError(w, http.StatusNotFound, err.Error())
	case errors.Is(err, service.ErrExists):
		writeError(w, http.StatusConflict, err.Error())
	default:
		writeError(w, http.StatusBadRequest, err.Error())
	}
}

var nonSlug = regexp.MustCompile(`[^a-z0-9]+`)

// slug makes an id from a name: "Deportes HD" becomes "deportes-hd".
func slug(name string) string {
	s := strings.Trim(nonSlug.ReplaceAllString(strings.ToLower(name), "-"), "-")
	if len(s) > 40 {
		s = strings.Trim(s[:40], "-")
	}
	return s
}

// ---- handlers ----

func (s *Server) info(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, s.cfg.Info)
}

func (s *Server) list(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, s.mgr.List())
}

func (s *Server) get(w http.ResponseWriter, r *http.Request) {
	v, err := s.mgr.Get(r.PathValue("id"))
	if err != nil {
		failure(w, err)
		return
	}
	writeJSON(w, http.StatusOK, v)
}

func (s *Server) create(w http.ResponseWriter, r *http.Request) {
	svc, ok := decodeService(w, r)
	if !ok {
		return
	}
	if svc.ID == "" {
		svc.ID = slug(svc.Name)
	}
	v, err := s.mgr.Create(svc)
	if err != nil {
		failure(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, v)
}

func (s *Server) update(w http.ResponseWriter, r *http.Request) {
	svc, ok := decodeService(w, r)
	if !ok {
		return
	}
	if svc.ID != "" && svc.ID != r.PathValue("id") {
		writeError(w, http.StatusBadRequest, "the id of a service cannot change")
		return
	}
	svc.ID = r.PathValue("id")
	v, err := s.mgr.Update(svc)
	if err != nil {
		failure(w, err)
		return
	}
	writeJSON(w, http.StatusOK, v)
}

func (s *Server) remove(w http.ResponseWriter, r *http.Request) {
	if err := s.mgr.Delete(r.PathValue("id")); err != nil {
		failure(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) setEnabled(enabled bool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		v, err := s.mgr.SetEnabled(r.PathValue("id"), enabled)
		if err != nil {
			failure(w, err)
			return
		}
		writeJSON(w, http.StatusOK, v)
	}
}

func (s *Server) switchInput(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Input *int `json:"input"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxBody)).Decode(&body); err != nil || body.Input == nil {
		writeError(w, http.StatusBadRequest, `body must be {"input": n} with n starting at 0`)
		return
	}
	if err := s.mgr.Switch(r.PathValue("id"), *body.Input); err != nil {
		failure(w, err)
		return
	}
	v, _ := s.mgr.Get(r.PathValue("id"))
	writeJSON(w, http.StatusOK, v)
}
