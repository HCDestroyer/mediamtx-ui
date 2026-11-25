package binaries

import (
	"context"
	"os/exec"
	"strings"
	"time"
)

// Tool describes an external program the agent can use.
type Tool struct {
	ID      string `json:"id"`
	Found   bool   `json:"found"`
	Path    string `json:"path,omitempty"`
	Version string `json:"version,omitempty"`
}

type probe struct {
	id   string
	bin  string
	args []string
}

// Tools looks for the helpers by name. FFmpeg may live elsewhere, hence the explicit path.
func Tools(ffmpeg string) []Tool {
	probes := []probe{
		{"ffmpeg", ffmpeg, []string{"-version"}},
		{"tsduck", "tsp", []string{"--version"}},
		{"dvblast", "dvblast", []string{"-V"}},
	}
	out := make([]Tool, 0, len(probes))
	for _, p := range probes {
		out = append(out, detect(p))
	}
	return out
}

func detect(p probe) Tool {
	t := Tool{ID: p.id}
	path, err := exec.LookPath(p.bin)
	if err != nil {
		return t
	}
	t.Found, t.Path = true, path
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	// Some tools print their version on stderr and exit non-zero; a line of text is all that is needed.
	data, _ := exec.CommandContext(ctx, path, p.args...).CombinedOutput()
	line, _, _ := strings.Cut(strings.TrimSpace(string(data)), "\n")
	t.Version = strings.TrimSpace(line)
	return t
}
