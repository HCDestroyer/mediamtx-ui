package media

import (
	"context"
	"fmt"
	"net/http"
	"os"
	"strings"
	"time"

	"nodo/agent/internal/addr"
	"nodo/agent/internal/ts"
)

// ---- http ----

type httpInput struct{ url string }

func newHTTPInput(a addr.Address) (Input, error) { return &httpInput{url: a.WithoutOptions()}, nil }

func (in *httpInput) Run(ctx context.Context, emit func([]byte)) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, in.url, nil)
	if err != nil {
		return err
	}
	req.Header.Set("User-Agent", "nodo-agent")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		if ctx.Err() != nil {
			return nil
		}
		return fmt.Errorf("%s: %w", Redact(in.url), err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("%s answered %s", Redact(in.url), resp.Status)
	}
	var align Aligner
	buf := make([]byte, 64*1024)
	for {
		n, err := resp.Body.Read(buf)
		if n > 0 {
			align.Write(buf[:n], emit)
		}
		if err != nil {
			if ctx.Err() != nil {
				return nil
			}
			return fmt.Errorf("%s: %w", Redact(in.url), err)
		}
	}
}

// ---- file ----

type fileInput struct {
	path string
	kbps int
}

func newFileInput(a addr.Address) (Input, error) {
	kbps, err := a.Int("rate", 4000)
	if err != nil {
		return nil, err
	}
	if kbps < 100 {
		return nil, fmt.Errorf("rate must be at least 100 kbps")
	}
	return &fileInput{path: strings.TrimPrefix(a.Rest, "/"), kbps: kbps}, nil
}

// Run plays the file in a loop at a constant rate: a stand-in for a live source.
func (in *fileInput) Run(ctx context.Context, emit func([]byte)) error {
	path := in.path
	if !strings.HasPrefix(path, "/") {
		path = "/" + path // file:///abs/path keeps its leading slash
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	if len(data) < ts.PacketSize*3 {
		return fmt.Errorf("%s is too short to be a transport stream", path)
	}
	const batch = 7 * ts.PacketSize
	interval := time.Duration(float64(batch*8) / float64(in.kbps*1000) * float64(time.Second))
	next := time.Now()
	var align Aligner
	for {
		for off := 0; off < len(data); off += batch {
			end := min(off+batch, len(data))
			align.Write(data[off:end], emit)
			next = next.Add(interval)
			select {
			case <-ctx.Done():
				return nil
			case <-time.After(time.Until(next)):
			}
		}
	}
}

// fileOutput appends the stream to a file; it exists for diagnostics and tests.
type fileOutput struct{ path string }

func newFileOutput(a addr.Address) (Output, error) {
	p := a.Rest
	if !strings.HasPrefix(p, "/") {
		p = "/" + p
	}
	return &fileOutput{path: p}, nil
}

func (o *fileOutput) Run(ctx context.Context, in <-chan []byte) error {
	f, err := os.OpenFile(o.path, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		return err
	}
	defer f.Close()
	for {
		select {
		case <-ctx.Done():
			return nil
		case batch, ok := <-in:
			if !ok {
				return nil
			}
			if _, err := f.Write(batch); err != nil {
				return err
			}
		}
	}
}
