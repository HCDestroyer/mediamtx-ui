package supervisor

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"
)

func script(t *testing.T, body string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "mediamtx")
	if err := os.WriteFile(path, []byte("#!/bin/sh\n"+body), 0o755); err != nil {
		t.Fatal(err)
	}
	return path
}

func newSup(t *testing.T, bin *string) *Supervisor {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	dir := t.TempDir()
	s := New(ctx, Config{
		Binary:      func() string { return *bin },
		Args:        func() []string { return []string{"conf.yml"} },
		Dir:         dir,
		StatePath:   filepath.Join(dir, "supervisor.json"),
		MinBackoff:  20 * time.Millisecond,
		MaxBackoff:  80 * time.Millisecond,
		StopTimeout: time.Second,
	})
	t.Cleanup(func() { s.Close(); cancel() })
	return s
}

func eventually(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", what)
}

func TestStartRunsTheBinaryWithItsArgumentsAndKeepsItsOutput(t *testing.T) {
	bin := script(t, "echo \"args: $@\"\necho second >&2\nexec sleep 30\n")
	s := newSup(t, &bin)
	if err := s.Start(); err != nil {
		t.Fatal(err)
	}
	eventually(t, "running", func() bool { return s.Status().State == Running && s.Status().PID > 0 })
	eventually(t, "output", func() bool { return strings.Contains(strings.Join(s.Logs(0), "\n"), "args: conf.yml") })
	if logs := strings.Join(s.Logs(0), "\n"); !strings.Contains(logs, "second") {
		t.Fatalf("stderr not captured: %q", logs)
	}
	if st := s.Status(); !st.Enabled || st.Binary != bin || st.Since == 0 {
		t.Fatalf("%+v", st)
	}
}

func TestStopKillsTheChildAndTheWholeGroup(t *testing.T) {
	pidFile := filepath.Join(t.TempDir(), "grandchild")
	bin := script(t, "sleep 60 &\necho $! > "+pidFile+"\nwait\n")
	s := newSup(t, &bin)
	_ = s.Start()
	eventually(t, "grandchild started", func() bool { _, err := os.Stat(pidFile); return err == nil })
	data, _ := os.ReadFile(pidFile)
	var pid int
	for _, c := range strings.TrimSpace(string(data)) {
		pid = pid*10 + int(c-'0')
	}
	s.Stop()
	if st := s.Status(); st.State != Stopped || st.Enabled {
		t.Fatalf("%+v", st)
	}
	eventually(t, "grandchild gone", func() bool { return syscall.Kill(pid, 0) != nil })
}

func TestCrashedProcessIsRestartedWithBackoffAndCounted(t *testing.T) {
	counter := filepath.Join(t.TempDir(), "runs")
	bin := script(t, "echo run >> "+counter+"\nexit 3\n")
	s := newSup(t, &bin)
	_ = s.Start()
	eventually(t, "several restarts", func() bool { return s.Status().Restarts >= 3 })
	st := s.Status()
	if st.LastExit == "" || !strings.Contains(st.LastExit, "exit status 3") {
		t.Fatalf("last exit %q", st.LastExit)
	}
	data, _ := os.ReadFile(counter)
	if n := strings.Count(string(data), "run"); n < 3 {
		t.Fatalf("started %d times", n)
	}
	s.Stop()
}

func TestRestartReplacesTheProcessWithoutCountingACrash(t *testing.T) {
	bin := script(t, "exec sleep 30\n")
	s := newSup(t, &bin)
	_ = s.Start()
	eventually(t, "running", func() bool { return s.Status().PID > 0 })
	first := s.Status().PID
	if err := s.Restart(); err != nil {
		t.Fatal(err)
	}
	eventually(t, "new pid", func() bool { st := s.Status(); return st.State == Running && st.PID > 0 && st.PID != first })
	if s.Status().Restarts != 0 {
		t.Fatalf("an operator restart counted as a crash: %d", s.Status().Restarts)
	}
}

func TestRestartPicksUpAnotherVersion(t *testing.T) {
	v1 := script(t, "echo version-one\nexec sleep 30\n")
	v2 := script(t, "echo version-two\nexec sleep 30\n")
	bin := v1
	s := newSup(t, &bin)
	_ = s.Start()
	eventually(t, "v1", func() bool { return strings.Contains(strings.Join(s.Logs(0), ""), "version-one") })
	bin = v2
	_ = s.Restart()
	eventually(t, "v2", func() bool {
		return strings.Contains(strings.Join(s.Logs(0), ""), "version-two") && s.Status().Binary == v2
	})
}

func TestStartWithoutABinaryIsRefused(t *testing.T) {
	bin := ""
	s := newSup(t, &bin)
	if err := s.Start(); err != ErrNoBinary {
		t.Fatalf("got %v", err)
	}
	if s.Status().Enabled {
		t.Fatal("enabled without a binary")
	}
}

func TestSavedWishToRunSurvivesAnAgentRestartButStopForgetsIt(t *testing.T) {
	bin := script(t, "exec sleep 30\n")
	first := newSup(t, &bin)
	_ = first.Start()
	eventually(t, "running", func() bool { return first.Status().State == Running })
	first.Close() // agent shutdown: keeps the wish

	second := New(context.Background(), Config{Binary: func() string { return bin }, Args: func() []string { return nil }, StatePath: first.cfg.StatePath, StopTimeout: time.Second})
	t.Cleanup(second.Close)
	second.Restore()
	eventually(t, "restored", func() bool { return second.Status().State == Running })

	second.Stop() // the operator asks to stop: stays stopped
	third := New(context.Background(), Config{Binary: func() string { return bin }, Args: func() []string { return nil }, StatePath: first.cfg.StatePath})
	third.Restore()
	if third.Status().Enabled {
		t.Fatal("a stopped MediaMTX came back")
	}
}

func TestLogRingKeepsTheNewestLines(t *testing.T) {
	r := newRing(3)
	for _, l := range []string{"a", "b", "c", "d", "e"} {
		r.add(l)
	}
	if got := strings.Join(r.last(0), ""); got != "cde" {
		t.Fatalf("%q", got)
	}
	if got := strings.Join(r.last(2), ""); got != "de" {
		t.Fatalf("%q", got)
	}
}

func TestStartTwiceAndStopTwiceAreHarmless(t *testing.T) {
	bin := script(t, "exec sleep 30\n")
	s := newSup(t, &bin)
	_ = s.Start()
	_ = s.Start()
	eventually(t, "running", func() bool { return s.Status().State == Running })
	s.Stop()
	s.Stop()
	if err := s.Start(); err != nil { // can be started again after a stop
		t.Fatal(err)
	}
	eventually(t, "running again", func() bool { return s.Status().State == Running })
}
