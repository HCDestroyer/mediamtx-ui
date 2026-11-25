package api

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"nodo/agent/internal/auth"
	"nodo/agent/internal/media"
	"nodo/agent/internal/service"
)

func init() { auth.Iterations = 1000 }

func newAuthServer(t *testing.T) (*httptest.Server, *auth.Store) {
	t.Helper()
	accounts, err := auth.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	mgr := service.NewManager(ctx, media.Config{}, slog.New(slog.NewTextHandler(io.Discard, nil)), nopStore{})
	limiter := auth.NewLimiter(3, time.Hour, time.Hour)
	srv := httptest.NewServer(New(Config{Token: token, Info: Info{Version: "test"}, Accounts: accounts, Limiter: limiter}, mgr))
	t.Cleanup(func() { srv.Close(); mgr.StopAll(); cancel() })
	return srv, accounts
}

func session(t *testing.T, body string) string {
	t.Helper()
	var reply sessionReply
	_ = json.Unmarshal([]byte(body), &reply)
	if reply.Token == "" {
		t.Fatalf("no token in %q", body)
	}
	return reply.Token
}

func TestSetupNeedsTheAPITokenAndWorksOnce(t *testing.T) {
	srv, _ := newAuthServer(t)
	_, body := do(t, srv, "GET", "/api/v1/auth/status", "", "")
	if !strings.Contains(body, `"setup":true`) || !strings.Contains(body, `"agent":true`) {
		t.Fatalf("status %s", body)
	}
	creds := `{"username":"admin","password":"correct horse"}`
	if resp, _ := do(t, srv, "POST", "/api/v1/auth/setup", "", creds); resp.StatusCode != 401 {
		t.Fatalf("setup without the token: %d", resp.StatusCode)
	}
	if resp, _ := do(t, srv, "POST", "/api/v1/auth/setup", "Bearer "+token, `{"username":"admin","password":"short"}`); resp.StatusCode != 400 {
		t.Fatalf("weak password: %d", resp.StatusCode)
	}
	resp, body := do(t, srv, "POST", "/api/v1/auth/setup", "Bearer "+token, creds)
	if resp.StatusCode != 201 {
		t.Fatalf("setup: %d %s", resp.StatusCode, body)
	}
	if resp, _ := do(t, srv, "POST", "/api/v1/auth/setup", "Bearer "+token, creds); resp.StatusCode != 409 {
		t.Fatalf("second setup must not take over the panel: %d", resp.StatusCode)
	}
	if _, body := do(t, srv, "GET", "/api/v1/auth/status", "", ""); !strings.Contains(body, `"setup":false`) {
		t.Fatalf("status after setup %s", body)
	}
}

func TestLoginGivesASessionThatOpensTheAPI(t *testing.T) {
	srv, accounts := newAuthServer(t)
	_ = accounts.Create("admin", "correct horse")
	if resp, _ := do(t, srv, "GET", "/api/v1/services", "", ""); resp.StatusCode != 401 {
		t.Fatalf("anonymous: %d", resp.StatusCode)
	}
	resp, body := do(t, srv, "POST", "/api/v1/auth/login", "", `{"username":"admin","password":"correct horse"}`)
	if resp.StatusCode != 200 {
		t.Fatalf("login: %d %s", resp.StatusCode, body)
	}
	tok := session(t, body)
	if resp, _ := do(t, srv, "GET", "/api/v1/services", "Bearer "+tok, ""); resp.StatusCode != 200 {
		t.Fatalf("with session: %d", resp.StatusCode)
	}
	if resp, _ := do(t, srv, "GET", "/api/v1/services", "Bearer "+token, ""); resp.StatusCode != 200 {
		t.Fatalf("the API token keeps working: %d", resp.StatusCode)
	}
	if resp, _ := do(t, srv, "GET", "/api/v1/services", "Bearer "+tok+"x", ""); resp.StatusCode != 401 {
		t.Fatalf("tampered session: %d", resp.StatusCode)
	}
}

func TestWrongLoginsAreIndistinguishableAndRateLimited(t *testing.T) {
	srv, accounts := newAuthServer(t)
	_ = accounts.Create("admin", "correct horse")
	r1, b1 := do(t, srv, "POST", "/api/v1/auth/login", "", `{"username":"admin","password":"nope nope"}`)
	r2, b2 := do(t, srv, "POST", "/api/v1/auth/login", "", `{"username":"ghost","password":"nope nope"}`)
	if r1.StatusCode != 401 || r2.StatusCode != 401 || b1 != b2 {
		t.Fatalf("unknown user must look like a wrong password: %d %q / %d %q", r1.StatusCode, b1, r2.StatusCode, b2)
	}
	do(t, srv, "POST", "/api/v1/auth/login", "", `{"username":"admin","password":"nope nope"}`)
	do(t, srv, "POST", "/api/v1/auth/login", "", `{"username":"admin","password":"nope nope"}`)
	resp, _ := do(t, srv, "POST", "/api/v1/auth/login", "", `{"username":"admin","password":"correct horse"}`)
	if resp.StatusCode != 429 || resp.Header.Get("Retry-After") == "" {
		t.Fatalf("after 3 failures even the right password waits: %d", resp.StatusCode)
	}
}

func TestPasswordChangeNeedsASessionAndEndsOldOnes(t *testing.T) {
	srv, accounts := newAuthServer(t)
	_ = accounts.Create("admin", "correct horse")
	_, body := do(t, srv, "POST", "/api/v1/auth/login", "", `{"username":"admin","password":"correct horse"}`)
	old := session(t, body)
	change := `{"current":"correct horse","new":"brand new password"}`
	if resp, _ := do(t, srv, "POST", "/api/v1/auth/password", "Bearer "+token, change); resp.StatusCode != 401 {
		t.Fatalf("the API token cannot change a user's password: %d", resp.StatusCode)
	}
	if resp, _ := do(t, srv, "POST", "/api/v1/auth/password", "Bearer "+old, `{"current":"wrong","new":"brand new password"}`); resp.StatusCode != 401 {
		t.Fatalf("wrong current: %d", resp.StatusCode)
	}
	resp, body := do(t, srv, "POST", "/api/v1/auth/password", "Bearer "+old, change)
	if resp.StatusCode != 200 {
		t.Fatalf("change: %d %s", resp.StatusCode, body)
	}
	fresh := session(t, body)
	if resp, _ := do(t, srv, "GET", "/api/v1/services", "Bearer "+old, ""); resp.StatusCode != 401 {
		t.Fatalf("old session still valid: %d", resp.StatusCode)
	}
	if resp, _ := do(t, srv, "GET", "/api/v1/services", "Bearer "+fresh, ""); resp.StatusCode != 200 {
		t.Fatalf("returned session: %d", resp.StatusCode)
	}
}

func TestAccountsDisabledKeepsTokenOnly(t *testing.T) {
	srv := newServer(t)
	if resp, _ := do(t, srv, "POST", "/api/v1/auth/login", "", `{"username":"a","password":"b"}`); resp.StatusCode != 404 {
		t.Fatalf("login: %d", resp.StatusCode)
	}
	_, body := do(t, srv, "GET", "/api/v1/auth/status", "", "")
	if !strings.Contains(body, `"accounts":false`) {
		t.Fatal(body)
	}
}
