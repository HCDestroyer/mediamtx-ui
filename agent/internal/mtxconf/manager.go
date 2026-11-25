package mtxconf

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// Validator checks a candidate configuration file; the real one runs `mediamtx --validate-conf`.
type Validator func(path string) error

// Paths of the three files.
type Paths struct {
	Base    string // the operator's mediamtx.yml; read only, may be empty
	Overlay string // the additional file, owned by the agent
	Out     string // the merged file MediaMTX is started with
}

// Manager keeps Out equal to Merge(Base, Overlay) and never leaves a bad file behind.
type Manager struct {
	paths    Paths
	validate Validator // nil: only the structural checks
	mu       sync.Mutex
}

// New creates the manager and its directory.
func New(p Paths, v Validator) (*Manager, error) {
	if p.Overlay == "" || p.Out == "" {
		return nil, errors.New("overlay and output paths are required")
	}
	for _, f := range []string{p.Overlay, p.Out} {
		if err := os.MkdirAll(filepath.Dir(f), 0o700); err != nil {
			return nil, err
		}
	}
	return &Manager{paths: p, validate: v}, nil
}

// MediaMTXValidator runs `<bin> --validate-conf <file>` and returns MediaMTX's own message on failure.
func MediaMTXValidator(bin string) Validator {
	return func(path string) error {
		ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		defer cancel()
		out, err := exec.CommandContext(ctx, bin, "--validate-conf", path).CombinedOutput()
		if err == nil {
			return nil
		}
		msg := strings.TrimSpace(string(out))
		if i := strings.LastIndex(msg, "ERR: "); i >= 0 {
			msg = strings.TrimSpace(msg[i+5:])
		}
		if msg == "" {
			msg = err.Error()
		}
		return &InvalidError{Message: msg}
	}
}

// InvalidError reports a configuration rejected by validation; nothing was changed.
type InvalidError struct{ Message string }

func (e *InvalidError) Error() string { return e.Message }

func readOptional(path string) ([]byte, error) {
	if path == "" {
		return nil, nil
	}
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	return data, err
}

func writeAtomic(path string, data []byte) error {
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

// State describes the files for the panel.
type State struct {
	BasePath  string `json:"basePath"`
	BaseFound bool   `json:"baseFound"`
	OutPath   string `json:"outPath"`
	OutFound  bool   `json:"outFound"`
	Overlay   string `json:"overlay"`
	Validator bool   `json:"validator"`
	CanUndo   bool   `json:"canUndo"`
}

// State reads the current files.
func (m *Manager) State() (State, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	overlay, err := readOptional(m.paths.Overlay)
	if err != nil {
		return State{}, err
	}
	_, baseErr := os.Stat(m.paths.Base)
	_, outErr := os.Stat(m.paths.Out)
	_, undoErr := os.Stat(m.paths.Overlay + ".prev")
	return State{
		BasePath: m.paths.Base, BaseFound: m.paths.Base != "" && baseErr == nil,
		OutPath: m.paths.Out, OutFound: outErr == nil,
		Overlay: string(overlay), Validator: m.validate != nil, CanUndo: undoErr == nil,
	}, nil
}

// Preview merges and validates a candidate overlay without changing anything. The merged text has
// secret values masked.
func (m *Manager) Preview(overlay string) (merged string, err error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	data, err := m.build([]byte(overlay))
	return string(Mask(data)), err
}

// build merges and validates the result, without touching Out.
func (m *Manager) build(overlay []byte) ([]byte, error) {
	if err := CheckOverlay(overlay); err != nil {
		return nil, &InvalidError{Message: err.Error()}
	}
	base, err := readOptional(m.paths.Base)
	if err != nil {
		return nil, err
	}
	merged, err := Merge(base, overlay)
	if err != nil {
		return nil, &InvalidError{Message: err.Error()}
	}
	if m.validate != nil {
		tmp, err := os.CreateTemp(filepath.Dir(m.paths.Out), ".candidate-*.yml")
		if err != nil {
			return nil, err
		}
		defer os.Remove(tmp.Name())
		if _, err := tmp.Write(merged); err != nil {
			tmp.Close()
			return nil, err
		}
		tmp.Close()
		if err := m.validate(tmp.Name()); err != nil {
			return nil, err
		}
	}
	return merged, nil
}

// Apply validates the overlay and, only if it is valid, replaces Out (MediaMTX hot-reloads it) and
// stores the overlay. The previous overlay and output are kept so Undo can return to them.
func (m *Manager) Apply(overlay string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	merged, err := m.build([]byte(overlay))
	if err != nil {
		return err
	}
	// Keep one step of history, but only when the overlay really changes: regenerating at start-up
	// or after editing mediamtx.yml must not erase what Undo can return to.
	if prev, err := readOptional(m.paths.Overlay); err == nil && prev != nil && string(prev) != overlay {
		_ = writeAtomic(m.paths.Overlay+".prev", prev)
		if out, err := readOptional(m.paths.Out); err == nil && out != nil {
			_ = writeAtomic(m.paths.Out+".prev", out)
		}
	}
	if err := writeAtomic(m.paths.Out, merged); err != nil {
		return err
	}
	return writeAtomic(m.paths.Overlay, []byte(overlay))
}

// Regenerate rebuilds Out from the current base and overlay (after the operator edited mediamtx.yml, and
// at start-up). It validates first and leaves the existing Out untouched when the result is invalid.
func (m *Manager) Regenerate() error {
	m.mu.Lock()
	overlay, err := readOptional(m.paths.Overlay)
	m.mu.Unlock()
	if err != nil {
		return err
	}
	return m.Apply(string(overlay))
}

// Undo restores the previous overlay and output.
func (m *Manager) Undo() error {
	m.mu.Lock()
	defer m.mu.Unlock()
	prev, err := os.ReadFile(m.paths.Overlay + ".prev")
	if err != nil {
		return errors.New("there is nothing to undo")
	}
	merged, err := m.build(prev)
	if err != nil {
		return fmt.Errorf("the previous configuration is no longer valid: %w", err)
	}
	if err := writeAtomic(m.paths.Out, merged); err != nil {
		return err
	}
	if err := writeAtomic(m.paths.Overlay, prev); err != nil {
		return err
	}
	return os.Remove(m.paths.Overlay + ".prev")
}
