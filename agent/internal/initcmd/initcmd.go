// Package initcmd registers the agent as a systemd service, like `astra init` does for Astra.
package initcmd

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

const (
	DefaultPort = 9980
	DefaultName = "nodo"
)

// Options describe the service to register.
type Options struct {
	Name string // service and data directory name
	Port int    // port of the web interface and API
	Exe  string // absolute path of the agent binary
	// Listen is the bind address; empty means all interfaces on Port.
	Listen string
	// MediaMTXConf is the operator's mediamtx.yml and MediaMTXBin the mediamtx binary used to validate
	// changes; both optional. With MediaMTXConf set the agent manages an additional configuration file.
	MediaMTXConf string
	MediaMTXBin  string
}

var namePattern = regexp.MustCompile(`^[a-z][a-z0-9-]{0,30}$`)

// Validate rejects values that would end up in a unit file or a path.
func (o Options) Validate() error {
	if !namePattern.MatchString(o.Name) {
		return fmt.Errorf("service name %q must be lowercase letters, digits and dashes, starting with a letter (max 31)", o.Name)
	}
	if o.Port < 1 || o.Port > 65535 {
		return fmt.Errorf("port %d is out of range", o.Port)
	}
	if !filepath.IsAbs(o.Exe) || strings.ContainsAny(o.Exe, " \t\n\"'\\$%") {
		return fmt.Errorf("binary path %q must be absolute and contain no spaces or special characters", o.Exe)
	}
	if strings.ContainsAny(o.Listen, " \t\n\"'\\$%") {
		return fmt.Errorf("listen address %q is not valid", o.Listen)
	}
	for _, p := range []string{o.MediaMTXConf, o.MediaMTXBin} {
		if p != "" && (!filepath.IsAbs(p) || strings.ContainsAny(p, " \t\n\"'\\$%")) {
			return fmt.Errorf("path %q must be absolute and contain no spaces or special characters", p)
		}
	}
	return nil
}

// DataDir is where the service keeps services.json and the token.
func (o Options) DataDir() string { return "/etc/nodo/" + o.Name }

// UnitPath is the systemd unit file.
func (o Options) UnitPath() string { return "/etc/systemd/system/" + o.Name + ".service" }

func (o Options) listen() string {
	if o.Listen != "" {
		return o.Listen
	}
	return fmt.Sprintf("0.0.0.0:%d", o.Port)
}

func (o Options) extraFlags() string {
	var b strings.Builder
	if o.MediaMTXConf != "" {
		b.WriteString(" -mediamtx-conf " + o.MediaMTXConf)
	}
	if o.MediaMTXBin != "" {
		b.WriteString(" -mediamtx-bin " + o.MediaMTXBin)
	}
	return b.String()
}

// Unit renders the systemd unit.
func Unit(o Options) string {
	return fmt.Sprintf(`[Unit]
Description=Nodo agent (%[1]s)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=%[2]s -listen %[3]s -data %[4]s%[5]s
Restart=always
RestartSec=2
LimitNOFILE=65536
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=true

[Install]
WantedBy=multi-user.target
`, o.Name, o.Exe, o.listen(), o.DataDir(), o.extraFlags())
}

// Install writes the unit and creates the data directory under root ("/" in production; a temporary
// directory in tests). It never starts the service.
func Install(o Options, root string) (unitFile, dataDir string, err error) {
	if err := o.Validate(); err != nil {
		return "", "", err
	}
	dataDir = filepath.Join(root, o.DataDir())
	unitFile = filepath.Join(root, o.UnitPath())
	if err := os.MkdirAll(dataDir, 0o700); err != nil {
		return "", "", err
	}
	if err := os.MkdirAll(filepath.Dir(unitFile), 0o755); err != nil {
		return "", "", err
	}
	tmp := unitFile + ".tmp"
	if err := os.WriteFile(tmp, []byte(Unit(o)), 0o644); err != nil {
		return "", "", err
	}
	if err := os.Rename(tmp, unitFile); err != nil {
		return "", "", err
	}
	return unitFile, dataDir, nil
}
