// Package api serves the agent's HTTP API: JSON over HTTP with a bearer token.
package api

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"

	"nodo/agent/internal/auth"
	"nodo/agent/internal/binaries"
	"nodo/agent/internal/mtxconf"
	"nodo/agent/internal/service"
	"nodo/agent/internal/supervisor"
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
	// Accounts enables user and password login (session tokens). Nil leaves only the API token.
	Accounts *auth.Store
	// Limiter slows down password guessing per client address; defaults to 5 free failures, then 2 s doubling to 10 min.
	Limiter *auth.Limiter
	// MediaMTX manages the additional MediaMTX configuration file; nil disables /api/v1/mediamtx.
	MediaMTX *mtxconf.Manager
	// Binaries installs MediaMTX versions; Supervisor runs the selected one. Either may be nil.
	Binaries   *binaries.Manager
	Supervisor *supervisor.Supervisor
	// FFmpeg is the FFmpeg binary (or name) reported by /binaries.
	FFmpeg string
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
	if cfg.Limiter == nil {
		cfg.Limiter = auth.NewLimiter(5, 2*time.Second, 10*time.Minute)
	}
	s := &Server{cfg: cfg, mgr: mgr, mux: http.NewServeMux()}
	s.mux.HandleFunc("GET /api/v1/mediamtx/config", s.auth(s.mtxState))
	s.mux.HandleFunc("PUT /api/v1/mediamtx/config", s.auth(s.mtxApply))
	s.mux.HandleFunc("POST /api/v1/mediamtx/validate", s.auth(s.mtxValidate))
	s.mux.HandleFunc("POST /api/v1/mediamtx/undo", s.auth(s.mtxUndo))
	s.mux.HandleFunc("PUT /api/v1/mediamtx/paths/{name...}", s.auth(s.mtxPath("set")))
	s.mux.HandleFunc("PATCH /api/v1/mediamtx/paths/{name...}", s.auth(s.mtxPath("patch")))
	s.mux.HandleFunc("DELETE /api/v1/mediamtx/paths/{name...}", s.auth(s.mtxPath("remove")))
	s.mux.HandleFunc("GET /api/v1/binaries", s.auth(s.binList))
	s.mux.HandleFunc("GET /api/v1/binaries/mediamtx/latest", s.auth(s.binLatest))
	s.mux.HandleFunc("POST /api/v1/binaries/mediamtx/install", s.auth(s.binInstall))
	s.mux.HandleFunc("POST /api/v1/binaries/mediamtx/use", s.auth(s.binUse))
	s.mux.HandleFunc("DELETE /api/v1/binaries/mediamtx/{version}", s.auth(s.binRemove))
	s.mux.HandleFunc("GET /api/v1/mediamtx/process", s.auth(s.procStatus))
	s.mux.HandleFunc("POST /api/v1/mediamtx/process/{action}", s.auth(s.procAction))
	s.mux.HandleFunc("GET /api/v1/auth/status", s.authStatus)
	s.mux.HandleFunc("POST /api/v1/auth/setup", s.authSetup)
	s.mux.HandleFunc("POST /api/v1/auth/login", s.authLogin)
	s.mux.HandleFunc("POST /api/v1/auth/password", s.authPassword)
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
			h.Set("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS")
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

// bearer extracts the credential of a request.
func bearer(r *http.Request) string {
	got, _ := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
	return got
}

func (s *Server) isAPIToken(got string) bool {
	return got != "" && s.cfg.Token != "" && subtle.ConstantTimeCompare([]byte(got), []byte(s.cfg.Token)) == 1
}

// sessionUser returns the account of a valid session token.
func (s *Server) sessionUser(got string) (string, bool) {
	if s.cfg.Accounts == nil || got == "" {
		return "", false
	}
	return s.cfg.Accounts.Check(got)
}

// auth accepts the long-lived API token (integrations, first-run setup) or a session token from a login.
func (s *Server) auth(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		got := bearer(r)
		if _, ok := s.sessionUser(got); !ok && !s.isAPIToken(got) {
			time.Sleep(200 * time.Millisecond) // slows down guessing
			writeError(w, http.StatusUnauthorized, "missing or wrong credentials")
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

// ---- accounts ----

type credentials struct {
	Username string `json:"username"`
	Password string `json:"password"`
}

type sessionReply struct {
	Token    string `json:"token"`
	Expires  int64  `json:"expires"`
	Username string `json:"username"`
}

func clientKey(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host // X-Forwarded-For is not trusted: anyone could forge it to dodge the limiter
}

func decodeBody(w http.ResponseWriter, r *http.Request, v any) bool {
	return decodeBodyMax(w, r, v, 1<<14)
}

func decodeBodyMax(w http.ResponseWriter, r *http.Request, v any, limit int64) bool {
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, limit))
	dec.DisallowUnknownFields()
	if err := dec.Decode(v); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON: "+err.Error())
		return false
	}
	return true
}

func (s *Server) accountsEnabled(w http.ResponseWriter) bool {
	if s.cfg.Accounts == nil {
		writeError(w, http.StatusNotFound, "accounts are not enabled")
		return false
	}
	return true
}

// authStatus is public: the panel uses it to decide between "set up", "log in" and "enter the token".
func (s *Server) authStatus(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"agent":    true,
		"version":  s.cfg.Info.Version,
		"accounts": s.cfg.Accounts != nil,
		"setup":    s.cfg.Accounts != nil && !s.cfg.Accounts.HasAccounts(),
	})
}

func (s *Server) newSession(w http.ResponseWriter, status int, name string, epoch int) {
	token, exp := s.cfg.Accounts.Issue(name, epoch)
	writeJSON(w, status, sessionReply{Token: token, Expires: exp.Unix(), Username: name})
}

func accountError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, auth.ErrExists):
		writeError(w, http.StatusConflict, err.Error())
	case errors.Is(err, auth.ErrWeak), errors.Is(err, auth.ErrBadUsername):
		writeError(w, http.StatusBadRequest, err.Error())
	default:
		writeError(w, http.StatusInternalServerError, "could not save the account")
	}
}

// authSetup creates the first account. It needs the API token, so only whoever installed the agent
// (and can read the token file) can claim an empty panel.
func (s *Server) authSetup(w http.ResponseWriter, r *http.Request) {
	if !s.accountsEnabled(w) {
		return
	}
	if !s.isAPIToken(bearer(r)) {
		time.Sleep(200 * time.Millisecond)
		writeError(w, http.StatusUnauthorized, "the API token is needed to create the first account")
		return
	}
	var c credentials
	if !decodeBody(w, r, &c) {
		return
	}
	if err := s.cfg.Accounts.Create(c.Username, c.Password); err != nil {
		accountError(w, err)
		return
	}
	s.newSession(w, http.StatusCreated, c.Username, 0)
}

func (s *Server) authLogin(w http.ResponseWriter, r *http.Request) {
	if !s.accountsEnabled(w) {
		return
	}
	key := clientKey(r)
	if wait := s.cfg.Limiter.Wait(key); wait > 0 {
		w.Header().Set("Retry-After", strconv.Itoa(int(wait.Seconds())+1))
		writeError(w, http.StatusTooManyRequests, "too many attempts, try again later")
		return
	}
	var c credentials
	if !decodeBody(w, r, &c) {
		return
	}
	epoch, err := s.cfg.Accounts.Verify(c.Username, c.Password)
	if err != nil {
		s.cfg.Limiter.Fail(key)
		writeError(w, http.StatusUnauthorized, "wrong username or password")
		return
	}
	s.cfg.Limiter.Succeed(key)
	s.newSession(w, http.StatusOK, c.Username, epoch)
}

// authPassword changes the password of the logged-in account; it needs a session, not the API token.
func (s *Server) authPassword(w http.ResponseWriter, r *http.Request) {
	if !s.accountsEnabled(w) {
		return
	}
	user, ok := s.sessionUser(bearer(r))
	if !ok {
		writeError(w, http.StatusUnauthorized, "log in first")
		return
	}
	key := clientKey(r)
	if wait := s.cfg.Limiter.Wait(key); wait > 0 {
		w.Header().Set("Retry-After", strconv.Itoa(int(wait.Seconds())+1))
		writeError(w, http.StatusTooManyRequests, "too many attempts, try again later")
		return
	}
	var body struct {
		Current string `json:"current"`
		New     string `json:"new"`
	}
	if !decodeBody(w, r, &body) {
		return
	}
	if _, err := s.cfg.Accounts.Verify(user, body.Current); err != nil {
		s.cfg.Limiter.Fail(key)
		writeError(w, http.StatusUnauthorized, "the current password is not correct")
		return
	}
	if err := s.cfg.Accounts.Set(user, body.New); err != nil {
		accountError(w, err)
		return
	}
	epoch, _ := s.cfg.Accounts.Verify(user, body.New)
	s.newSession(w, http.StatusOK, user, epoch)
}

// ---- MediaMTX configuration (additional file) ----

type overlayBody struct {
	Overlay string `json:"overlay"`
}

func (s *Server) mtxEnabled(w http.ResponseWriter) bool {
	if s.cfg.MediaMTX == nil {
		writeError(w, http.StatusNotFound, "MediaMTX configuration management is not enabled on this agent")
		return false
	}
	return true
}

func mtxFailure(w http.ResponseWriter, err error) {
	var invalid *mtxconf.InvalidError
	if errors.As(err, &invalid) {
		writeError(w, http.StatusUnprocessableEntity, invalid.Message)
		return
	}
	writeError(w, http.StatusInternalServerError, err.Error())
}

func (s *Server) mtxState(w http.ResponseWriter, _ *http.Request) {
	if !s.mtxEnabled(w) {
		return
	}
	st, err := s.cfg.MediaMTX.State()
	if err != nil {
		mtxFailure(w, err)
		return
	}
	writeJSON(w, http.StatusOK, st)
}

// mtxValidate checks a candidate without saving it: {ok, error} or {ok, merged} (secrets masked).
func (s *Server) mtxValidate(w http.ResponseWriter, r *http.Request) {
	if !s.mtxEnabled(w) {
		return
	}
	var body overlayBody
	if !decodeBodyMax(w, r, &body, 2<<20) {
		return
	}
	merged, err := s.cfg.MediaMTX.Preview(body.Overlay)
	var invalid *mtxconf.InvalidError
	switch {
	case errors.As(err, &invalid):
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "error": invalid.Message})
	case err != nil:
		mtxFailure(w, err)
	default:
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "merged": merged})
	}
}

// mtxApply validates and applies; an invalid configuration is answered with 422 and changes nothing.
func (s *Server) mtxApply(w http.ResponseWriter, r *http.Request) {
	if !s.mtxEnabled(w) {
		return
	}
	var body overlayBody
	if !decodeBodyMax(w, r, &body, 2<<20) {
		return
	}
	if err := s.cfg.MediaMTX.Apply(body.Overlay); err != nil {
		mtxFailure(w, err)
		return
	}
	s.mtxState(w, r)
}

func (s *Server) mtxUndo(w http.ResponseWriter, r *http.Request) {
	if !s.mtxEnabled(w) {
		return
	}
	if err := s.cfg.MediaMTX.Undo(); err != nil {
		var invalid *mtxconf.InvalidError
		if errors.As(err, &invalid) {
			mtxFailure(w, err)
		} else {
			writeError(w, http.StatusConflict, err.Error())
		}
		return
	}
	s.mtxState(w, r)
}

// mtxPath keeps a path of the MediaMTX configuration in the additional file, so a channel created or
// changed from the panel survives a restart. The body is {"conf": {...}} (not used for removal).
func (s *Server) mtxPath(op string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !s.mtxEnabled(w) {
			return
		}
		name := r.PathValue("name")
		var err error
		if op == "remove" {
			err = s.cfg.MediaMTX.RemovePath(name)
		} else {
			var body struct {
				Conf map[string]any `json:"conf"`
			}
			if !decodeBodyMax(w, r, &body, 1<<20) {
				return
			}
			if body.Conf == nil {
				writeError(w, http.StatusBadRequest, "conf is required")
				return
			}
			if op == "set" {
				err = s.cfg.MediaMTX.SetPath(name, body.Conf)
			} else {
				err = s.cfg.MediaMTX.PatchPath(name, body.Conf)
			}
		}
		if err != nil {
			mtxFailure(w, err)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}
}

// ---- binaries and the MediaMTX process ----

func (s *Server) binEnabled(w http.ResponseWriter) bool {
	if s.cfg.Binaries == nil {
		writeError(w, http.StatusNotFound, "binary management is not enabled on this agent")
		return false
	}
	return true
}

func binFailure(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, binaries.ErrBadVersion):
		writeError(w, http.StatusBadRequest, err.Error())
	case errors.Is(err, binaries.ErrNotFound):
		writeError(w, http.StatusNotFound, err.Error())
	case errors.Is(err, binaries.ErrBusy), errors.Is(err, binaries.ErrInUse), errors.Is(err, supervisor.ErrNoBinary):
		writeError(w, http.StatusConflict, err.Error())
	default:
		writeError(w, http.StatusBadGateway, err.Error())
	}
}

type mediamtxBinaries struct {
	Installed []string           `json:"installed"`
	Current   string             `json:"current"`
	Process   *supervisor.Status `json:"process,omitempty"`
}

func (s *Server) binSnapshot() mediamtxBinaries {
	out := mediamtxBinaries{Installed: s.cfg.Binaries.Installed(), Current: s.cfg.Binaries.Current()}
	if out.Installed == nil {
		out.Installed = []string{}
	}
	if s.cfg.Supervisor != nil {
		st := s.cfg.Supervisor.Status()
		out.Process = &st
	}
	return out
}

func (s *Server) binList(w http.ResponseWriter, _ *http.Request) {
	if !s.binEnabled(w) {
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"mediamtx": s.binSnapshot(), "tools": binaries.Tools(s.cfg.FFmpeg)})
}

func (s *Server) binLatest(w http.ResponseWriter, r *http.Request) {
	if !s.binEnabled(w) {
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
	defer cancel()
	tag, err := s.cfg.Binaries.Latest(ctx)
	if err != nil {
		binFailure(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"version": tag})
}

type versionBody struct {
	Version string `json:"version"`
}

// binInstall downloads and verifies a version ("latest" or a tag). It can take a while, so it holds the
// request open; the panel shows a spinner.
func (s *Server) binInstall(w http.ResponseWriter, r *http.Request) {
	if !s.binEnabled(w) {
		return
	}
	var body versionBody
	if !decodeBody(w, r, &body) {
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Minute)
	defer cancel()
	if _, err := s.cfg.Binaries.Install(ctx, body.Version); err != nil {
		binFailure(w, err)
		return
	}
	writeJSON(w, http.StatusOK, s.binSnapshot())
}

// binUse selects a version and, when MediaMTX is running under the agent, restarts it on that version.
func (s *Server) binUse(w http.ResponseWriter, r *http.Request) {
	if !s.binEnabled(w) {
		return
	}
	var body versionBody
	if !decodeBody(w, r, &body) {
		return
	}
	if err := s.cfg.Binaries.Use(body.Version); err != nil {
		binFailure(w, err)
		return
	}
	if s.cfg.Supervisor != nil && s.cfg.Supervisor.Status().Enabled {
		if err := s.cfg.Supervisor.Restart(); err != nil {
			binFailure(w, err)
			return
		}
	}
	writeJSON(w, http.StatusOK, s.binSnapshot())
}

func (s *Server) binRemove(w http.ResponseWriter, r *http.Request) {
	if !s.binEnabled(w) {
		return
	}
	if err := s.cfg.Binaries.Remove(r.PathValue("version")); err != nil {
		binFailure(w, err)
		return
	}
	writeJSON(w, http.StatusOK, s.binSnapshot())
}

func (s *Server) procEnabled(w http.ResponseWriter) bool {
	if s.cfg.Supervisor == nil {
		writeError(w, http.StatusNotFound, "running MediaMTX from the agent needs -mediamtx-conf and binary management")
		return false
	}
	return true
}

func (s *Server) procStatus(w http.ResponseWriter, r *http.Request) {
	if !s.procEnabled(w) {
		return
	}
	lines, _ := strconv.Atoi(r.URL.Query().Get("lines"))
	if lines <= 0 || lines > 500 {
		lines = 200
	}
	writeJSON(w, http.StatusOK, map[string]any{"status": s.cfg.Supervisor.Status(), "logs": s.cfg.Supervisor.Logs(lines)})
}

func (s *Server) procAction(w http.ResponseWriter, r *http.Request) {
	if !s.procEnabled(w) {
		return
	}
	var err error
	switch r.PathValue("action") {
	case "start":
		err = s.cfg.Supervisor.Start()
	case "stop":
		s.cfg.Supervisor.Stop()
	case "restart":
		err = s.cfg.Supervisor.Restart()
	default:
		writeError(w, http.StatusNotFound, "unknown action")
		return
	}
	if err != nil {
		binFailure(w, err)
		return
	}
	s.procStatus(w, r)
}
