package media

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os/exec"
	"strings"
	"sync"
)

// FFmpeg is only a protocol adapter here: it copies the streams (-c copy), so it costs almost no CPU.
// The processing that matters (PIDs, PSI, continuity, failover) happens in the agent.

// ffmpegInputArgs reads any URL FFmpeg understands and writes MPEG-TS to stdout.
func ffmpegInputArgs(url string) []string {
	args := []string{"-hide_banner", "-loglevel", "error", "-nostdin"}
	if strings.HasPrefix(url, "rtsp://") || strings.HasPrefix(url, "rtsps://") {
		args = append(args, "-rtsp_transport", "tcp")
	}
	return append(args,
		"-i", url,
		"-map", "0:v?", "-map", "0:a?", "-map", "0:s?",
		"-c", "copy",
		"-flush_packets", "1", "-muxdelay", "0", "-muxpreload", "0",
		"-f", "mpegts", "pipe:1")
}

// ffmpegOutputArgs reads MPEG-TS from stdin and publishes it to a URL in the given container format.
func ffmpegOutputArgs(url, format string) []string {
	args := []string{
		"-hide_banner", "-loglevel", "error",
		"-f", "mpegts", "-i", "pipe:0",
		"-map", "0:v?", "-map", "0:a?",
		"-c", "copy",
	}
	if format == "rtsp" {
		args = append(args, "-rtsp_transport", "tcp")
	}
	return append(args, "-f", format, url)
}

// tailBuffer keeps the end of FFmpeg's stderr to explain a failure.
type tailBuffer struct {
	mu  sync.Mutex
	buf []byte
}

func (t *tailBuffer) Write(p []byte) (int, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.buf = append(t.buf, p...)
	if len(t.buf) > 2048 {
		t.buf = t.buf[len(t.buf)-2048:]
	}
	return len(p), nil
}

func (t *tailBuffer) String() string {
	t.mu.Lock()
	defer t.mu.Unlock()
	return strings.TrimSpace(string(bytes.ToValidUTF8(t.buf, nil)))
}

// Redact hides credentials of a URL so errors and logs can show it.
func Redact(s string) string {
	if i := strings.Index(s, "://"); i >= 0 {
		rest := s[i+3:]
		if at := strings.LastIndex(rest, "@"); at >= 0 && !strings.Contains(rest[:at], "/") {
			return s[:i+3] + "***@" + rest[at+1:]
		}
	}
	return s
}

type ffmpegInput struct {
	bin, url string
}

func newFFmpegInput(url string, cfg Config) (Input, error) {
	return &ffmpegInput{bin: ffmpegBin(cfg), url: url}, nil
}

func ffmpegBin(cfg Config) string {
	if cfg.FFmpeg != "" {
		return cfg.FFmpeg
	}
	return "ffmpeg"
}

func (in *ffmpegInput) Run(ctx context.Context, emit func([]byte)) error {
	cmd := exec.CommandContext(ctx, in.bin, ffmpegInputArgs(in.url)...)
	stderr := &tailBuffer{}
	cmd.Stderr = stderr
	out, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("cannot start ffmpeg: %w", err)
	}
	var align Aligner
	buf := make([]byte, 64*1024)
	for {
		n, rerr := out.Read(buf)
		if n > 0 {
			align.Write(buf[:n], emit)
		}
		if rerr != nil {
			if !errors.Is(rerr, io.EOF) {
				_ = cmd.Process.Kill()
			}
			break
		}
	}
	werr := cmd.Wait()
	if ctx.Err() != nil {
		return nil
	}
	return fmt.Errorf("ffmpeg stopped reading %s: %v: %s", Redact(in.url), werr, stderr.String())
}

type ffmpegOutput struct {
	bin, url, format string
}

func newFFmpegOutput(url, format string, cfg Config) (Output, error) {
	return &ffmpegOutput{bin: ffmpegBin(cfg), url: url, format: format}, nil
}

func (o *ffmpegOutput) Run(ctx context.Context, in <-chan []byte) error {
	cmd := exec.CommandContext(ctx, o.bin, ffmpegOutputArgs(o.url, o.format)...)
	stderr := &tailBuffer{}
	cmd.Stderr = stderr
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return err
	}
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("cannot start ffmpeg: %w", err)
	}
	exited := make(chan error, 1)
	go func() { exited <- cmd.Wait() }()
	for {
		select {
		case <-ctx.Done():
			_ = stdin.Close()
			<-exited
			return nil
		case err := <-exited:
			return fmt.Errorf("ffmpeg stopped publishing to %s: %v: %s", Redact(o.url), err, stderr.String())
		case batch, ok := <-in:
			if !ok {
				_ = stdin.Close()
				<-exited
				return nil
			}
			if _, err := stdin.Write(batch); err != nil {
				<-exited
				return fmt.Errorf("ffmpeg stopped publishing to %s: %s", Redact(o.url), stderr.String())
			}
		}
	}
}
