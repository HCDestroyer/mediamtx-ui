package initcmd

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func opts() Options { return Options{Name: "nodo", Port: 9980, Exe: "/usr/bin/nodo-agent"} }

func TestUnitHasTheStartCommandAndRestartPolicy(t *testing.T) {
	unit := Unit(opts())
	for _, want := range []string{
		"ExecStart=/usr/bin/nodo-agent -listen 0.0.0.0:9980 -data /etc/nodo/nodo\n",
		"Restart=always",
		"WantedBy=multi-user.target",
	} {
		if !strings.Contains(unit, want) {
			t.Errorf("missing %q in\n%s", want, unit)
		}
	}
}

func TestSecondInstanceGetsItsOwnNamePortAndData(t *testing.T) {
	o := Options{Name: "nodo2", Port: 9981, Exe: "/usr/bin/nodo-agent"}
	if !strings.Contains(Unit(o), "-listen 0.0.0.0:9981 -data /etc/nodo/nodo2") || o.UnitPath() != "/etc/systemd/system/nodo2.service" {
		t.Fatal(Unit(o))
	}
}

func TestExplicitListenAddress(t *testing.T) {
	o := opts()
	o.Listen = "10.8.0.2:9980"
	if !strings.Contains(Unit(o), "-listen 10.8.0.2:9980 ") {
		t.Fatal(Unit(o))
	}
}

func TestValidateRejectsAnythingThatCouldBreakTheUnitOrEscapeThePath(t *testing.T) {
	for _, bad := range []Options{
		{Name: "../etc", Port: 1, Exe: "/usr/bin/a"},
		{Name: "Nodo", Port: 1, Exe: "/usr/bin/a"},
		{Name: "a b", Port: 1, Exe: "/usr/bin/a"},
		{Name: "", Port: 1, Exe: "/usr/bin/a"},
		{Name: "nodo", Port: 0, Exe: "/usr/bin/a"},
		{Name: "nodo", Port: 70000, Exe: "/usr/bin/a"},
		{Name: "nodo", Port: 1, Exe: "relative/a"},
		{Name: "nodo", Port: 1, Exe: "/usr/bin/a b"},
		{Name: "nodo", Port: 1, Exe: "/usr/bin/a", Listen: "0.0.0.0:1 -x"},
		{Name: "nodo", Port: 1, Exe: "/usr/bin/$HOME"},
		{Name: "nodo", Port: 1, Exe: "/usr/bin/%n"},
	} {
		if err := bad.Validate(); err == nil {
			t.Errorf("%+v should be rejected", bad)
		}
	}
	if err := opts().Validate(); err != nil {
		t.Fatal(err)
	}
}

func TestInstallWritesUnitAndPrivateDataDir(t *testing.T) {
	root := t.TempDir()
	unit, data, err := Install(opts(), root)
	if err != nil {
		t.Fatal(err)
	}
	body, err := os.ReadFile(unit)
	if err != nil || !strings.Contains(string(body), "ExecStart=") {
		t.Fatalf("unit not written: %v", err)
	}
	if unit != filepath.Join(root, "etc/systemd/system/nodo.service") {
		t.Fatal(unit)
	}
	info, err := os.Stat(data)
	if err != nil || info.Mode().Perm() != 0o700 {
		t.Fatalf("data dir: %v %v", err, info)
	}
	// Running init again replaces the unit without failing (useful after moving the binary).
	if _, _, err := Install(Options{Name: "nodo", Port: 9990, Exe: "/opt/nodo-agent"}, root); err != nil {
		t.Fatal(err)
	}
	body, _ = os.ReadFile(unit)
	if !strings.Contains(string(body), "/opt/nodo-agent -listen 0.0.0.0:9990") {
		t.Fatal(string(body))
	}
}

func TestInstallRefusesInvalidOptionsWithoutTouchingDisk(t *testing.T) {
	root := t.TempDir()
	if _, _, err := Install(Options{Name: "../x", Port: 1, Exe: "/a"}, root); err == nil {
		t.Fatal("expected error")
	}
	entries, _ := os.ReadDir(root)
	if len(entries) != 0 {
		t.Fatalf("wrote %d entries", len(entries))
	}
}

func TestMediaMTXFlagsReachTheUnit(t *testing.T) {
	o := opts()
	o.MediaMTXConf = "/etc/mediamtx/mediamtx.yml"
	o.MediaMTXBin = "/usr/local/bin/mediamtx"
	if !strings.Contains(Unit(o), "-data /etc/nodo/nodo -mediamtx-conf /etc/mediamtx/mediamtx.yml -mediamtx-bin /usr/local/bin/mediamtx\n") {
		t.Fatal(Unit(o))
	}
	o.MediaMTXConf = "relative.yml"
	if o.Validate() == nil {
		t.Fatal("relative path accepted")
	}
	o.MediaMTXConf = "/etc/a b.yml"
	if o.Validate() == nil {
		t.Fatal("path with a space accepted")
	}
}
