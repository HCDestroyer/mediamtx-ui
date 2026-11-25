package store

import (
	"os"
	"path/filepath"
	"testing"

	"nodo/agent/internal/service"
)

func TestRoundTripAndPermissions(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "data")
	s, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	if got, err := s.Load(); err != nil || len(got) != 0 {
		t.Fatalf("empty store: %v %v", got, err)
	}
	in := []service.Service{{ID: "a", Name: "A", Enabled: true, Inputs: []service.Input{{URL: "udp://127.0.0.1:1"}}}}
	if err := s.Save(in); err != nil {
		t.Fatal(err)
	}
	out, err := s.Load()
	if err != nil || len(out) != 1 || out[0].ID != "a" || out[0].Inputs[0].URL != "udp://127.0.0.1:1" {
		t.Fatalf("round trip: %+v %v", out, err)
	}
	info, _ := os.Stat(filepath.Join(dir, "services.json"))
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("services.json must be private, is %o", info.Mode().Perm())
	}
	dirInfo, _ := os.Stat(dir)
	if dirInfo.Mode().Perm() != 0o700 {
		t.Fatalf("data dir must be private, is %o", dirInfo.Mode().Perm())
	}
	entries, _ := os.ReadDir(dir)
	if len(entries) != 1 {
		t.Fatalf("temporary files left behind: %v", entries)
	}
}

func TestCorruptFileIsReportedNotErased(t *testing.T) {
	dir := t.TempDir()
	s, _ := Open(dir)
	path := filepath.Join(dir, "services.json")
	if err := os.WriteFile(path, []byte("{not json"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Load(); err == nil {
		t.Fatal("a corrupt file must be an error")
	}
	if data, _ := os.ReadFile(path); string(data) != "{not json" {
		t.Fatal("loading must never overwrite the file")
	}
}
