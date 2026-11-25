package media

import (
	"context"
	"fmt"
	"net/url"
	"strings"

	"nodo/agent/internal/addr"
)

// Config holds what inputs and outputs need to know about the host.
type Config struct {
	// FFmpeg is the binary used as protocol adapter.
	FFmpeg string
	// MediaMTXRTSP is the RTSP base URL of the local MediaMTX, e.g. rtsp://127.0.0.1:8554.
	MediaMTXRTSP string
	// MediaMTXUser and MediaMTXPass authenticate against MediaMTX when it asks for credentials.
	MediaMTXUser, MediaMTXPass string
}

// Input produces transport-stream chunks until the context ends or it fails.
// emit receives chunks that are multiples of 188 bytes; the slice is only valid during the call.
type Input interface {
	Run(ctx context.Context, emit func([]byte)) error
}

// Output consumes transport-stream batches until the context ends, the channel closes or it fails.
type Output interface {
	Run(ctx context.Context, in <-chan []byte) error
}

// mediaMTXURL turns mediamtx://path into the RTSP URL of the local MediaMTX.
func (c Config) mediaMTXURL(path string) (string, error) {
	if c.MediaMTXRTSP == "" {
		return "", fmt.Errorf("mediamtx:// needs the agent to know where MediaMTX listens (-mediamtx-rtsp)")
	}
	u, err := url.Parse(c.MediaMTXRTSP)
	if err != nil || u.Host == "" {
		return "", fmt.Errorf("invalid MediaMTX RTSP address %q", c.MediaMTXRTSP)
	}
	if c.MediaMTXUser != "" {
		u.User = url.UserPassword(c.MediaMTXUser, c.MediaMTXPass)
	}
	u.Path = "/" + strings.TrimPrefix(path, "/")
	return u.String(), nil
}

// NewInput builds the input for an address. The scheme decides how it is read:
//
//	udp://, rtp://      sockets, handled natively
//	http://…, https://  MPEG-TS over HTTP, natively (an .m3u8 playlist goes through FFmpeg)
//	file://             a .ts file played in a loop at a given rate (tests and demos)
//	mediamtx://<path>   a MediaMTX path, read over RTSP through FFmpeg: MediaMTX pulls any protocol
//	rtsp://, rtmp://, srt://, rtsps://…  read through FFmpeg
func NewInput(a addr.Address, cfg Config) (Input, error) {
	switch a.Scheme {
	case "udp", "rtp":
		return newUDPInput(a)
	case "http", "https":
		if strings.Contains(strings.ToLower(a.Rest), ".m3u8") {
			return newFFmpegInput(a.WithoutOptions(), cfg)
		}
		return newHTTPInput(a)
	case "file":
		return newFileInput(a)
	case "mediamtx":
		u, err := cfg.mediaMTXURL(a.Rest)
		if err != nil {
			return nil, err
		}
		return newFFmpegInput(u, cfg)
	case "rtsp", "rtsps", "rtmp", "rtmps", "srt":
		return newFFmpegInput(a.WithoutOptions(), cfg)
	}
	return nil, fmt.Errorf("unsupported input type %q", a.Scheme)
}

// NewOutput builds the output for an address:
//
//	udp://, rtp://     sockets, handled natively (options: ttl, pkt)
//	file://            writes the stream to a file (diagnostics)
//	mediamtx://<path>  publishes into a MediaMTX path through FFmpeg; MediaMTX then offers it as
//	                   RTSP, RTMP, SRT, HLS and WebRTC, and can forward it to other servers
//	rtmp://, rtmps://, srt://, rtsp://  published through FFmpeg
func NewOutput(a addr.Address, cfg Config) (Output, error) {
	switch a.Scheme {
	case "udp", "rtp":
		return newUDPOutput(a)
	case "file":
		return newFileOutput(a)
	case "mediamtx":
		u, err := cfg.mediaMTXURL(a.Rest)
		if err != nil {
			return nil, err
		}
		return newFFmpegOutput(u, "rtsp", cfg)
	case "rtmp", "rtmps":
		return newFFmpegOutput(a.WithoutOptions(), "flv", cfg)
	case "srt":
		return newFFmpegOutput(a.WithoutOptions(), "mpegts", cfg)
	case "rtsp", "rtsps":
		return newFFmpegOutput(a.WithoutOptions(), "rtsp", cfg)
	}
	return nil, fmt.Errorf("unsupported output type %q", a.Scheme)
}
