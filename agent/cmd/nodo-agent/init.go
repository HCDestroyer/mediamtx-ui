package main

import (
	"flag"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strconv"

	"nodo/agent/internal/initcmd"
)

// runInit implements `nodo-agent init [port] [name]`, modeled on `astra init`: it registers a systemd
// service (default name "nodo", default port 9980) and creates its data directory and API token.
// It does not start the service.
func runInit(args []string, out io.Writer) error {
	fs := flag.NewFlagSet("init", flag.ContinueOnError)
	fs.SetOutput(out)
	listen := fs.String("listen", "", "bind address instead of all interfaces, e.g. 10.8.0.2:9980")
	dry := fs.Bool("print", false, "print the systemd unit and change nothing (works without root)")
	fs.Usage = func() {
		fmt.Fprintln(out, "Usage: nodo-agent init [flags] [port] [name]\n\nRegisters the agent as a systemd service. Run it again with another port and name\nto add a second instance (each has its own services and token).\n\nFlags:")
		fs.PrintDefaults()
	}
	if err := fs.Parse(args); err != nil {
		return err
	}
	opts := initcmd.Options{Name: initcmd.DefaultName, Port: initcmd.DefaultPort, Listen: *listen}
	if fs.NArg() > 2 {
		return fmt.Errorf("too many arguments: %v", fs.Args()[2:])
	}
	if fs.NArg() >= 1 {
		port, err := strconv.Atoi(fs.Arg(0))
		if err != nil {
			return fmt.Errorf("port %q is not a number", fs.Arg(0))
		}
		opts.Port = port
	}
	if fs.NArg() == 2 {
		opts.Name = fs.Arg(1)
	}
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	if opts.Exe, err = filepath.EvalSymlinks(exe); err != nil {
		return err
	}
	if err := opts.Validate(); err != nil {
		return err
	}
	if *dry {
		fmt.Fprintf(out, "# %s\n%s", opts.UnitPath(), initcmd.Unit(opts))
		return nil
	}
	if os.Geteuid() != 0 {
		return fmt.Errorf("run it as root (or use -print to only see the unit)")
	}
	unit, dataDir, err := initcmd.Install(opts, "/")
	if err != nil {
		return err
	}
	if _, err := loadToken(dataDir, slog.New(slog.NewTextHandler(io.Discard, nil))); err != nil {
		return err
	}
	fmt.Fprintf(out, "Service %q registered: %s\nData and API token: %s (token file: %s)\n\n", opts.Name, unit, dataDir, filepath.Join(dataDir, "token"))
	fmt.Fprintf(out, "Next:\n  systemctl daemon-reload\n  systemctl enable --now %s\n\nThen open http://<this-server>:%d in a browser.\n", opts.Name, opts.Port)
	return nil
}
