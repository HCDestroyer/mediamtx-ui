//go:build !unix

package supervisor

import "os/exec"

func prepare(*exec.Cmd) {}

func signal(cmd *exec.Cmd, _ bool) {
	if cmd.Process != nil {
		_ = cmd.Process.Kill()
	}
}
