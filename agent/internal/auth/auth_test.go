package auth

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestMain(m *testing.M) {
	Iterations = 1000 // tests do not need the production cost
	os.Exit(m.Run())
}

func open(t *testing.T) (*Store, string) {
	t.Helper()
	dir := t.TempDir()
	s, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	return s, dir
}

func TestFirstAccountOnlyOnce(t *testing.T) {
	s, _ := open(t)
	if s.HasAccounts() {
		t.Fatal("fresh store has accounts")
	}
	if err := s.Create("admin", "correct horse"); err != nil {
		t.Fatal(err)
	}
	if err := s.Create("other", "another password"); !errors.Is(err, ErrExists) {
		t.Fatalf("second Create must fail, got %v", err)
	}
	if !s.HasAccounts() {
		t.Fatal("account missing")
	}
}

func TestValidation(t *testing.T) {
	s, _ := open(t)
	if err := s.Create("admin", "short"); !errors.Is(err, ErrWeak) {
		t.Fatalf("got %v", err)
	}
	for _, name := range []string{"", "has space", " lead", strings.Repeat("x", 65), "tab\t"} {
		if err := s.Create(name, "long enough pw"); !errors.Is(err, ErrBadUsername) {
			t.Errorf("%q: got %v", name, err)
		}
	}
	if err := s.Create("admin", strings.Repeat("a", 300)); !errors.Is(err, ErrWeak) {
		t.Fatalf("absurdly long password accepted: %v", err)
	}
}

func TestVerifyAndPersistence(t *testing.T) {
	s, dir := open(t)
	_ = s.Create("admin", "correct horse")
	if _, err := s.Verify("admin", "correct horse"); err != nil {
		t.Fatal(err)
	}
	for _, c := range [][2]string{{"admin", "wrong"}, {"nobody", "correct horse"}, {"admin", ""}} {
		if _, err := s.Verify(c[0], c[1]); !errors.Is(err, ErrBadLogin) {
			t.Errorf("%v: got %v", c, err)
		}
	}
	again, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := again.Verify("admin", "correct horse"); err != nil {
		t.Fatalf("account lost after reopening: %v", err)
	}
	raw, _ := os.ReadFile(filepath.Join(dir, usersFile))
	if strings.Contains(string(raw), "correct horse") {
		t.Fatal("password stored in clear")
	}
	for _, f := range []string{usersFile, secretFile} {
		if info, _ := os.Stat(filepath.Join(dir, f)); info.Mode().Perm() != 0o600 {
			t.Errorf("%s mode %v", f, info.Mode().Perm())
		}
	}
}

func TestSessionsSurviveRestartAndExpire(t *testing.T) {
	s, dir := open(t)
	_ = s.Create("admin", "correct horse")
	epoch, _ := s.Verify("admin", "correct horse")
	token, expires := s.Issue("admin", epoch)
	if user, ok := s.Check(token); !ok || user != "admin" {
		t.Fatal("fresh token rejected")
	}
	if expires.Sub(time.Now()) < 11*time.Hour {
		t.Fatalf("ttl too short: %v", expires)
	}
	restarted, _ := Open(dir)
	if _, ok := restarted.Check(token); !ok {
		t.Fatal("token must survive a restart (secret is persisted)")
	}
	restarted.now = func() time.Time { return time.Now().Add(SessionTTL + time.Minute) }
	if _, ok := restarted.Check(token); ok {
		t.Fatal("expired token accepted")
	}
}

func TestTamperedOrForeignTokensAreRejected(t *testing.T) {
	s, _ := open(t)
	_ = s.Create("admin", "correct horse")
	token, _ := s.Issue("admin", 0)
	parts := strings.Split(token, ".")
	other, _ := open(t) // different secret
	_ = other.Create("admin", "correct horse")
	for name, bad := range map[string]string{
		"empty":    "",
		"garbage":  "abc",
		"wrongmac": parts[0] + "." + parts[1] + ".AAAA",
		"swapped":  parts[0] + "." + "eyJ1IjoiYWRtaW4iLCJlIjowLCJ4Ijo5OTk5OTk5OTk5fQ" + "." + parts[2],
		"version":  "v2." + parts[1] + "." + parts[2],
		"foreign":  func() string { t, _ := other.Issue("admin", 0); return t }(),
	} {
		if _, ok := s.Check(bad); ok {
			t.Errorf("%s accepted", name)
		}
	}
}

func TestChangingThePasswordEndsOlderSessions(t *testing.T) {
	s, _ := open(t)
	_ = s.Create("admin", "correct horse")
	epoch, _ := s.Verify("admin", "correct horse")
	token, _ := s.Issue("admin", epoch)
	if err := s.ChangePassword("admin", "wrong", "new password!"); !errors.Is(err, ErrBadLogin) {
		t.Fatalf("got %v", err)
	}
	if err := s.ChangePassword("admin", "correct horse", "new password!"); err != nil {
		t.Fatal(err)
	}
	if _, ok := s.Check(token); ok {
		t.Fatal("session survived a password change")
	}
	if _, err := s.Verify("admin", "correct horse"); err == nil {
		t.Fatal("old password still works")
	}
	if _, err := s.Verify("admin", "new password!"); err != nil {
		t.Fatal(err)
	}
}

func TestSetCreatesOrResets(t *testing.T) {
	s, _ := open(t)
	if err := s.Set("admin", "first password"); err != nil {
		t.Fatal(err)
	}
	if err := s.Set("admin", "second password"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Verify("admin", "second password"); err != nil {
		t.Fatal(err)
	}
}

func TestLimiterBacksOffAndForgives(t *testing.T) {
	now := time.Unix(1000, 0)
	l := NewLimiter(3, 10*time.Second, time.Minute)
	l.now = func() time.Time { return now }
	for i := 0; i < 3; i++ {
		if l.Wait("ip") != 0 {
			t.Fatal("blocked within the free attempts")
		}
		l.Fail("ip")
	}
	if l.Wait("ip") != 0 {
		t.Fatal("the free attempts are free")
	}
	l.Fail("ip") // 4th failure: 10 s
	if w := l.Wait("ip"); w != 10*time.Second {
		t.Fatalf("wait %v", w)
	}
	now = now.Add(11 * time.Second)
	l.Fail("ip") // 5th: 20 s
	if w := l.Wait("ip"); w != 20*time.Second {
		t.Fatalf("wait %v", w)
	}
	for i := 0; i < 30; i++ {
		l.Fail("ip")
	}
	if w := l.Wait("ip"); w != time.Minute {
		t.Fatalf("capped wait %v", w)
	}
	if l.Wait("other") != 0 {
		t.Fatal("limits are per key")
	}
	l.Succeed("ip")
	if l.Wait("ip") != 0 {
		t.Fatal("success must reset")
	}
}

func TestChangesMadeByAnotherProcessAreSeen(t *testing.T) {
	running, dir := open(t)
	_ = running.Create("admin", "correct horse")
	epoch, _ := running.Verify("admin", "correct horse")
	token, _ := running.Issue("admin", epoch)

	cli, _ := Open(dir) // `nodo-agent passwd` while the agent keeps running
	if err := cli.Set("admin", "reset by the cli"); err != nil {
		t.Fatal(err)
	}
	if _, err := running.Verify("admin", "reset by the cli"); err != nil {
		t.Fatalf("running agent did not see the reset: %v", err)
	}
	if _, err := running.Verify("admin", "correct horse"); err == nil {
		t.Fatal("old password still accepted by the running agent")
	}
	if _, ok := running.Check(token); ok {
		t.Fatal("old session survived the reset")
	}
}
