// Package store keeps the service definitions in a JSON file owned by the agent.
package store

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"

	"nodo/agent/internal/service"
)

const fileName = "services.json"

type file struct {
	Version  int               `json:"version"`
	Services []service.Service `json:"services"`
}

// Store reads and writes services.json inside the data directory.
type Store struct {
	path string
	mu   sync.Mutex
}

// Open prepares the data directory (private to the agent's user).
func Open(dir string) (*Store, error) {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	return &Store{path: filepath.Join(dir, fileName)}, nil
}

// Load returns the saved services; a missing file means none yet.
func (s *Store) Load() ([]service.Service, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	data, err := os.ReadFile(s.path)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var f file
	if err := json.Unmarshal(data, &f); err != nil {
		return nil, fmt.Errorf("%s is not valid JSON: %w", s.path, err)
	}
	return f.Services, nil
}

// Save replaces the file atomically: a crash in the middle leaves the previous version intact.
func (s *Store) Save(services []service.Service) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	data, err := json.MarshalIndent(file{Version: 1, Services: services}, "", "  ")
	if err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(s.path), ".services-*.tmp")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if err := tmp.Chmod(0o600); err != nil {
		tmp.Close()
		return err
	}
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), s.path)
}
