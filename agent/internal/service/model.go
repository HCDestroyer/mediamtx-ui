// Package service runs transport-stream services: one or more inputs with automatic backup,
// a stabilizer that fixes the structure, and outputs. It is the agent's counterpart of an Astra stream.
package service

import (
	"fmt"
	"regexp"
	"strings"
	"time"

	"nodo/agent/internal/addr"
	"nodo/agent/internal/media"
	"nodo/agent/internal/stabilizer"
)

// Input is one source of a service. Address options: pnr (program number to follow), timeout is below.
type Input struct {
	URL string `json:"url"`
	// TimeoutSec is how long without data marks the input as down. Default: 5 for sockets and files, 10 otherwise.
	TimeoutSec int `json:"timeoutSec,omitempty"`
}

// Backup mode: "active" watches every input and switches on failure and back when the preferred one
// has been healthy for ReturnDelaySec; "manual" only switches on request.
type Backup struct {
	Mode           string `json:"mode"`
	ReturnDelaySec int    `json:"returnDelaySec,omitempty"`
}

// Output is a destination of the stabilized stream.
type Output struct {
	URL string `json:"url"`
}

// Service is the saved definition of a service.
type Service struct {
	ID      string             `json:"id"`
	Name    string             `json:"name"`
	Enabled bool               `json:"enabled"`
	Inputs  []Input            `json:"inputs"`
	Backup  Backup             `json:"backup"`
	Profile stabilizer.Profile `json:"profile"`
	Outputs []Output           `json:"outputs"`
}

const (
	ModeActive = "active"
	ModeManual = "manual"

	DefaultReturnDelay = 30
	maxInputs          = 8
	maxOutputs         = 8
)

var idPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{0,39}$`)

// Normalize fills the defaults.
func (s *Service) Normalize() {
	s.ID = strings.TrimSpace(s.ID)
	s.Name = strings.TrimSpace(s.Name)
	if s.Backup.Mode == "" {
		s.Backup.Mode = ModeActive
	}
	if s.Backup.ReturnDelaySec == 0 {
		s.Backup.ReturnDelaySec = DefaultReturnDelay
	}
	if s.Profile.Name == "" {
		s.Profile.Name = s.Name
	}
}

// InputTimeout is the time without data after which an input counts as down.
func (in Input) InputTimeout(a addr.Address) time.Duration {
	if in.TimeoutSec > 0 {
		return time.Duration(in.TimeoutSec) * time.Second
	}
	switch a.Scheme {
	case "udp", "rtp", "file":
		return 5 * time.Second
	}
	return 10 * time.Second
}

// Validate checks that the definition can run. It builds every input and output, so an unsupported
// address or a bad option is reported here rather than when the service starts.
func (s Service) Validate(cfg media.Config) error {
	if !idPattern.MatchString(s.ID) {
		return fmt.Errorf("id must be 1-40 characters: lowercase letters, digits, - and _")
	}
	if s.Name == "" {
		return fmt.Errorf("name is required")
	}
	if len(s.Inputs) == 0 || len(s.Inputs) > maxInputs {
		return fmt.Errorf("a service needs between 1 and %d inputs", maxInputs)
	}
	if len(s.Outputs) == 0 || len(s.Outputs) > maxOutputs {
		return fmt.Errorf("a service needs between 1 and %d outputs", maxOutputs)
	}
	for i, in := range s.Inputs {
		a, err := addr.Parse(in.URL)
		if err != nil {
			return fmt.Errorf("input %d: %w", i+1, err)
		}
		if _, err := media.NewInput(a, cfg); err != nil {
			return fmt.Errorf("input %d: %w", i+1, err)
		}
		if _, err := a.Int("pnr", 0); err != nil {
			return fmt.Errorf("input %d: %w", i+1, err)
		}
		if in.TimeoutSec < 0 {
			return fmt.Errorf("input %d: timeoutSec cannot be negative", i+1)
		}
	}
	for i, out := range s.Outputs {
		a, err := addr.Parse(out.URL)
		if err != nil {
			return fmt.Errorf("output %d: %w", i+1, err)
		}
		if _, err := media.NewOutput(a, cfg); err != nil {
			return fmt.Errorf("output %d: %w", i+1, err)
		}
	}
	switch s.Backup.Mode {
	case ModeActive, ModeManual:
	default:
		return fmt.Errorf("backup mode must be %q or %q", ModeActive, ModeManual)
	}
	if s.Backup.ReturnDelaySec < 0 {
		return fmt.Errorf("returnDelaySec cannot be negative")
	}
	if err := s.Profile.Validate(); err != nil {
		return fmt.Errorf("profile: %w", err)
	}
	return nil
}
