package main

import (
	"bufio"
	"flag"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strings"

	"nodo/agent/internal/auth"
)

// runPasswd implements `nodo-agent passwd [-service name | -data dir] <user>`: creates the account or
// resets its password (the way to recover access, like Astra's password reset). Sessions of that account end.
// The password comes from NODO_PASSWORD or is typed twice at the prompt.
func runPasswd(args []string, in *os.File, out io.Writer) error {
	fs := flag.NewFlagSet("passwd", flag.ContinueOnError)
	fs.SetOutput(out)
	service := fs.String("service", "nodo", "service name given to init")
	data := fs.String("data", "", "data directory (default /etc/nodo/<service>)")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if fs.NArg() != 1 {
		return fmt.Errorf("usage: nodo-agent passwd [-service name | -data dir] <user>")
	}
	dir := *data
	if dir == "" {
		dir = "/etc/nodo/" + *service
	}
	accounts, err := auth.Open(dir)
	if err != nil {
		return err
	}
	password := os.Getenv("NODO_PASSWORD")
	if password == "" {
		if password, err = promptPassword(in, out); err != nil {
			return err
		}
	}
	if err := accounts.Set(fs.Arg(0), password); err != nil {
		return err
	}
	fmt.Fprintf(out, "Password set for %q. Restart is not needed; sessions of that user were closed.\n", fs.Arg(0))
	return nil
}

func promptPassword(in *os.File, out io.Writer) (string, error) {
	interactive := false
	if info, err := in.Stat(); err == nil && info.Mode()&os.ModeCharDevice != 0 {
		interactive = true
		stty(in, "-echo")
		defer func() { stty(in, "echo"); fmt.Fprintln(out) }()
	}
	r := bufio.NewReader(in)
	read := func(label string) (string, error) {
		if interactive {
			fmt.Fprint(out, label)
		}
		line, err := r.ReadString('\n')
		if err != nil && line == "" {
			return "", fmt.Errorf("no password given (set NODO_PASSWORD or type it)")
		}
		return strings.TrimRight(line, "\r\n"), nil
	}
	first, err := read("New password: ")
	if err != nil || !interactive {
		return first, err
	}
	second, err := read("\nRepeat it: ")
	if err != nil {
		return "", err
	}
	if first != second {
		return "", fmt.Errorf("the passwords do not match")
	}
	return first, nil
}

func stty(tty *os.File, arg string) {
	cmd := exec.Command("stty", arg)
	cmd.Stdin = tty
	_ = cmd.Run()
}
