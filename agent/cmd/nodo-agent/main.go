// Command nodo-agent runs transport-stream services on a host: inputs with backup, a stabilizer that
// keeps PIDs and tables fixed, and outputs. The Nodo panel drives it through its HTTP API.
package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"nodo/agent/internal/api"
	"nodo/agent/internal/media"
	"nodo/agent/internal/service"
	"nodo/agent/internal/store"
	"nodo/agent/internal/web"
)

// version is overridden at build time: go build -ldflags "-X main.version=1.2.3".
var version = "0.1.0-dev"

func main() {
	if len(os.Args) > 1 && os.Args[1] == "init" {
		if err := runInit(os.Args[2:], os.Stdout); err != nil {
			fmt.Fprintln(os.Stderr, "init:", err)
			os.Exit(1)
		}
		return
	}
	var (
		listen   = flag.String("listen", "127.0.0.1:9980", "address of the web panel and API; bind to a LAN or VPN address only behind a firewall")
		dataDir  = flag.String("data", "./data", "directory for services.json and the token")
		ffmpeg   = flag.String("ffmpeg", "ffmpeg", "FFmpeg binary used as protocol adapter")
		rtsp     = flag.String("mediamtx-rtsp", "", "RTSP base URL of the local MediaMTX, e.g. rtsp://127.0.0.1:8554 (enables mediamtx:// addresses)")
		mtxUser  = flag.String("mediamtx-user", "", "MediaMTX user with publish and read permissions")
		origins  = flag.String("allow-origin", "*", "comma-separated origins allowed by CORS")
		certFile = flag.String("tls-cert", "", "TLS certificate for the API (with -tls-key)")
		keyFile  = flag.String("tls-key", "", "TLS key for the API")
		showVer  = flag.Bool("version", false, "print the version and exit")
	)
	flag.Usage = func() {
		fmt.Fprintf(os.Stderr, "Usage:\n  nodo-agent [flags]            run the agent\n  nodo-agent init [port] [name] register it as a systemd service (see init -h)\n\nFlags:\n")
		flag.PrintDefaults()
	}
	flag.Parse()
	if *showVer {
		fmt.Println(version)
		return
	}

	log := slog.New(slog.NewTextHandler(os.Stderr, nil))
	if err := run(log, *listen, *dataDir, *ffmpeg, *rtsp, *mtxUser, *origins, *certFile, *keyFile); err != nil {
		log.Error("agent stopped", "error", err)
		os.Exit(1)
	}
}

func run(log *slog.Logger, listen, dataDir, ffmpeg, rtsp, mtxUser, origins, certFile, keyFile string) error {
	st, err := store.Open(dataDir)
	if err != nil {
		return err
	}
	token, err := loadToken(dataDir, log)
	if err != nil {
		return err
	}

	cfg := media.Config{FFmpeg: ffmpeg, MediaMTXRTSP: rtsp, MediaMTXUser: mtxUser, MediaMTXPass: os.Getenv("NODO_MEDIAMTX_PASS")}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	mgr := service.NewManager(ctx, cfg, log, st)
	saved, err := st.Load()
	if err != nil {
		return err
	}
	mgr.Restore(saved)
	log.Info("services loaded", "count", len(saved))

	info := api.Info{Version: version, FFmpeg: ffmpegVersion(ffmpeg), MediaMTX: rtsp != "", StartedAt: time.Now().Unix()}
	if info.FFmpeg == "" {
		log.Warn("FFmpeg not found: only udp://, rtp://, http:// MPEG-TS and file:// addresses will work", "ffmpeg", ffmpeg)
	}
	srv := &http.Server{
		Addr:              listen,
		Handler:           api.New(api.Config{Token: token, AllowOrigins: splitList(origins), Info: info, Panel: web.Handler()}, mgr),
		ReadHeaderTimeout: 10 * time.Second,
	}
	errc := make(chan error, 1)
	go func() {
		log.Info("API listening", "address", listen, "tls", certFile != "")
		if certFile != "" {
			errc <- srv.ListenAndServeTLS(certFile, keyFile)
		} else {
			errc <- srv.ListenAndServe()
		}
	}()

	select {
	case err := <-errc:
		if !errors.Is(err, http.ErrServerClosed) {
			return err
		}
	case <-ctx.Done():
		log.Info("shutting down")
	}
	shutdown, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = srv.Shutdown(shutdown)
	mgr.StopAll()
	return nil
}

// loadToken reads the API token from NODO_TOKEN or <data>/token, creating a random one on first run.
// The value is never logged: only the file that holds it.
func loadToken(dir string, log *slog.Logger) (string, error) {
	if t := strings.TrimSpace(os.Getenv("NODO_TOKEN")); t != "" {
		return t, nil
	}
	path := filepath.Join(dir, "token")
	if data, err := os.ReadFile(path); err == nil {
		if t := strings.TrimSpace(string(data)); t != "" {
			return t, nil
		}
	}
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		return "", err
	}
	token := hex.EncodeToString(raw)
	if err := os.WriteFile(path, []byte(token+"\n"), 0o600); err != nil {
		return "", err
	}
	log.Info("created an API token", "file", path)
	return token, nil
}

func ffmpegVersion(bin string) string {
	out, err := exec.Command(bin, "-version").Output()
	if err != nil {
		return ""
	}
	line, _, _ := strings.Cut(string(out), "\n")
	return strings.TrimSpace(line)
}

func splitList(s string) []string {
	var out []string
	for _, p := range strings.Split(s, ",") {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return out
}
