// Package supervisor runs MediaMTX as a child of the agent: it starts it with the generated
// configuration, restarts it when it dies (with backoff), keeps its recent output and remembers whether
// the operator wants it running. It is optional: operators who run MediaMTX under their own systemd unit
// simply never start it.
package supervisor

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"os"
	"os/exec"
	"sync"
	"time"
)

// ErrNoBinary is returned by Start when no MediaMTX version is selected.
var ErrNoBinary = errors.New("no MediaMTX version is selected; install and select one first")

// State of the child process.
type State string

const (
	Stopped State = "stopped"
	// Starting covers the moment between asking for a start and the process existing.
	Starting State = "starting"
	Running  State = "running"
	// Crashed means it exited by itself and a restart is pending.
	Crashed State = "crashed"
)

// Config wires the supervisor to the rest of the agent.
type Config struct {
	// Binary returns the MediaMTX executable to run, or "" when none is selected. It is read at every start,
	// so switching versions takes effect on the next restart.
	Binary func() string
	// Args returns the arguments, normally the generated configuration file.
	Args func() []string
	// Dir is the working directory (MediaMTX writes recordings relative to it).
	Dir string
	// StatePath stores whether it should be running, so it comes back after the agent restarts.
	StatePath  string
	Log        *slog.Logger
	MinBackoff time.Duration
	MaxBackoff time.Duration
	// StopTimeout is how long it gets to exit after SIGTERM before it is killed.
	StopTimeout time.Duration
	LogLines    int
}

// Status is what the panel shows.
type Status struct {
	State    State  `json:"state"`
	Enabled  bool   `json:"enabled"`
	PID      int    `json:"pid,omitempty"`
	Since    int64  `json:"since,omitempty"`
	Restarts int    `json:"restarts"`
	LastExit string `json:"lastExit,omitempty"`
	Binary   string `json:"binary,omitempty"`
}

// Supervisor owns at most one child.
type Supervisor struct {
	cfg  Config
	ctx  context.Context
	ring *ring

	mu       sync.Mutex
	enabled  bool
	loopDone chan struct{}
	cancel   context.CancelFunc
	cmd      *exec.Cmd
	state    State
	since    time.Time
	restarts int
	lastExit string
	binary   string
	// intentional is set when the operator asked for the stop/restart, so the exit is not a crash.
	intentional bool
}

// New creates a stopped supervisor; call Restore to bring back the saved state.
func New(ctx context.Context, cfg Config) *Supervisor {
	if cfg.MinBackoff == 0 {
		cfg.MinBackoff = time.Second
	}
	if cfg.MaxBackoff == 0 {
		cfg.MaxBackoff = 30 * time.Second
	}
	if cfg.StopTimeout == 0 {
		cfg.StopTimeout = 10 * time.Second
	}
	if cfg.LogLines == 0 {
		cfg.LogLines = 500
	}
	if cfg.Log == nil {
		cfg.Log = slog.New(slog.NewTextHandler(io.Discard, nil))
	}
	return &Supervisor{cfg: cfg, ctx: ctx, ring: newRing(cfg.LogLines), state: Stopped}
}

type saved struct {
	Enabled bool `json:"enabled"`
}

func (s *Supervisor) persist(enabled bool) {
	if s.cfg.StatePath == "" {
		return
	}
	data, _ := json.Marshal(saved{Enabled: enabled})
	tmp := s.cfg.StatePath + ".tmp"
	if os.WriteFile(tmp, data, 0o600) == nil {
		_ = os.Rename(tmp, s.cfg.StatePath)
	}
}

// Restore starts MediaMTX again if the operator had left it running.
func (s *Supervisor) Restore() {
	data, err := os.ReadFile(s.cfg.StatePath)
	if err != nil {
		return
	}
	var st saved
	if json.Unmarshal(data, &st) != nil || !st.Enabled {
		return
	}
	if err := s.start(false); err != nil {
		s.cfg.Log.Warn("could not restore MediaMTX", "error", err)
	}
}

// Start launches MediaMTX and keeps it running until Stop.
func (s *Supervisor) Start() error { return s.start(true) }

func (s *Supervisor) start(save bool) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.enabled {
		return nil
	}
	if s.cfg.Binary() == "" {
		return ErrNoBinary
	}
	s.enabled = true
	s.state = Starting
	s.intentional = false
	if save {
		s.persist(true)
	}
	ctx, cancel := context.WithCancel(s.ctx)
	s.cancel = cancel
	s.loopDone = make(chan struct{})
	go s.loop(ctx, s.loopDone)
	return nil
}

// Stop ends MediaMTX and keeps it from coming back, also after an agent restart.
func (s *Supervisor) Stop() {
	s.mu.Lock()
	if !s.enabled {
		s.mu.Unlock()
		return
	}
	s.enabled = false
	s.persist(false)
	s.mu.Unlock()
	s.halt()
}

// Close stops the child because the agent is shutting down; the saved wish to run is kept.
func (s *Supervisor) Close() {
	s.mu.Lock()
	s.enabled = false
	s.mu.Unlock()
	s.halt()
}

func (s *Supervisor) halt() {
	s.mu.Lock()
	cancel, done, cmd := s.cancel, s.loopDone, s.cmd
	s.intentional = true
	s.mu.Unlock()
	if cancel == nil {
		return
	}
	cancel()
	if cmd != nil {
		signal(cmd, false)
	}
	select {
	case <-done:
	case <-time.After(s.cfg.StopTimeout + 2*time.Second):
	}
}

// Restart stops the child and starts it again at once (for example after switching versions).
func (s *Supervisor) Restart() error {
	s.mu.Lock()
	running := s.enabled
	cmd := s.cmd
	if running && cmd != nil {
		s.intentional = true
	}
	s.mu.Unlock()
	if !running {
		return s.Start()
	}
	if s.cfg.Binary() == "" {
		return ErrNoBinary
	}
	if cmd != nil {
		signal(cmd, false)
	}
	return nil
}

// Status reports the current state.
func (s *Supervisor) Status() Status {
	s.mu.Lock()
	defer s.mu.Unlock()
	st := Status{State: s.state, Enabled: s.enabled, Restarts: s.restarts, LastExit: s.lastExit, Binary: s.binary}
	if s.state == Running && s.cmd != nil && s.cmd.Process != nil {
		st.PID = s.cmd.Process.Pid
		st.Since = s.since.Unix()
	}
	return st
}

// Logs returns the last n lines of output, oldest first.
func (s *Supervisor) Logs(n int) []string { return s.ring.last(n) }

func (s *Supervisor) loop(ctx context.Context, done chan struct{}) {
	defer close(done)
	defer func() {
		s.mu.Lock()
		s.state, s.cmd = Stopped, nil
		s.mu.Unlock()
	}()
	backoff := s.cfg.MinBackoff
	for ctx.Err() == nil {
		bin := s.cfg.Binary()
		if bin == "" {
			s.setExit("no MediaMTX version is selected")
			if !sleep(ctx, backoff) {
				return
			}
			continue
		}
		started := time.Now()
		err := s.runOnce(ctx, bin)
		if ctx.Err() != nil {
			return
		}
		s.mu.Lock()
		intentional := s.intentional
		s.intentional = false
		if !intentional {
			s.restarts++
		}
		s.mu.Unlock()
		if intentional {
			backoff = s.cfg.MinBackoff
			continue // asked for: start again without waiting
		}
		msg := "exited"
		if err != nil {
			msg = err.Error()
		}
		s.setExit(msg)
		s.mu.Lock()
		s.state = Crashed
		s.mu.Unlock()
		s.cfg.Log.Warn("MediaMTX exited, restarting", "reason", msg, "in", backoff)
		if time.Since(started) > 10*time.Second {
			backoff = s.cfg.MinBackoff // it had been healthy: this is a new failure
		}
		if !sleep(ctx, backoff) {
			return
		}
		if backoff *= 2; backoff > s.cfg.MaxBackoff {
			backoff = s.cfg.MaxBackoff
		}
	}
}

func (s *Supervisor) setExit(msg string) {
	s.mu.Lock()
	s.lastExit = msg
	s.mu.Unlock()
}

func sleep(ctx context.Context, d time.Duration) bool {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-t.C:
		return true
	}
}

// runOnce starts the child and waits for it, stopping it when ctx ends.
func (s *Supervisor) runOnce(ctx context.Context, bin string) error {
	cmd := exec.Command(bin, s.cfg.Args()...)
	cmd.Dir = s.cfg.Dir
	prepare(cmd)
	out, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	cmd.Stderr = cmd.Stdout
	if err := cmd.Start(); err != nil {
		return err
	}
	s.mu.Lock()
	s.cmd, s.state, s.since, s.binary = cmd, Running, time.Now(), bin
	s.mu.Unlock()
	s.ring.add("--- started " + bin)

	readDone := make(chan struct{})
	go func() {
		defer close(readDone)
		sc := bufio.NewScanner(out)
		sc.Buffer(make([]byte, 64<<10), 1<<20)
		for sc.Scan() {
			s.ring.add(sc.Text())
		}
	}()
	waited := make(chan error, 1)
	go func() { <-readDone; waited <- cmd.Wait() }()

	select {
	case err := <-waited:
		return err
	case <-ctx.Done():
		signal(cmd, false)
		select {
		case <-waited:
		case <-time.After(s.cfg.StopTimeout):
			signal(cmd, true)
			<-waited
		}
		s.ring.add("--- stopped")
		return ctx.Err()
	}
}

// ---- ring buffer of output lines ----

type ring struct {
	mu    sync.Mutex
	lines []string
	max   int
}

func newRing(max int) *ring { return &ring{max: max} }

func (r *ring) add(line string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.lines = append(r.lines, line)
	if len(r.lines) > r.max {
		r.lines = append([]string(nil), r.lines[len(r.lines)-r.max:]...)
	}
}

func (r *ring) last(n int) []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	if n <= 0 || n > len(r.lines) {
		n = len(r.lines)
	}
	return append([]string{}, r.lines[len(r.lines)-n:]...) // never nil: the API sends [] not null
}
