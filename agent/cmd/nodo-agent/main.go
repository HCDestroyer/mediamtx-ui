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
	"sync"
	"syscall"
	"time"

	"nodo/agent/internal/api"
	"nodo/agent/internal/auth"
	"nodo/agent/internal/binaries"
	"nodo/agent/internal/host"
	"nodo/agent/internal/media"
	"nodo/agent/internal/mtxconf"
	"nodo/agent/internal/service"
	"nodo/agent/internal/store"
	"nodo/agent/internal/supervisor"
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
	if len(os.Args) > 1 && os.Args[1] == "passwd" {
		if err := runPasswd(os.Args[2:], os.Stdin, os.Stdout); err != nil {
			fmt.Fprintln(os.Stderr, "passwd:", err)
			os.Exit(1)
		}
		return
	}
	var (
		listen    = flag.String("listen", "127.0.0.1:9980", "address of the web panel and API; bind to a LAN or VPN address only behind a firewall")
		dataDir   = flag.String("data", "./data", "directory for services.json and the token")
		ffmpeg    = flag.String("ffmpeg", "ffmpeg", "FFmpeg binary used as protocol adapter")
		rtsp      = flag.String("mediamtx-rtsp", "", "RTSP base URL of the local MediaMTX, e.g. rtsp://127.0.0.1:8554 (enables mediamtx:// addresses)")
		mtxUser   = flag.String("mediamtx-user", "", "MediaMTX user with publish and read permissions")
		origins   = flag.String("allow-origin", "*", "comma-separated origins allowed by CORS")
		certFile  = flag.String("tls-cert", "", "TLS certificate for the API (with -tls-key)")
		keyFile   = flag.String("tls-key", "", "TLS key for the API")
		mtxConf   = flag.String("mediamtx-conf", "", "path of your mediamtx.yml (read only); enables the additional configuration file")
		mtxBin    = flag.String("mediamtx-bin", "", "mediamtx binary used to validate configurations before applying them (--validate-conf)")
		mtxMirror = flag.String("mediamtx-release-url", "", "base URL that serves MediaMTX releases (default: the official GitHub project); for a mirror or an offline network")
		showVer   = flag.Bool("version", false, "print the version and exit")
	)
	flag.Usage = func() {
		fmt.Fprintf(os.Stderr, "Usage:\n  nodo-agent [flags]            run the agent\n  nodo-agent init [port] [name] register it as a systemd service (see init -h)\n  nodo-agent passwd <user>      create a panel account or reset its password\n\nFlags:\n")
		flag.PrintDefaults()
	}
	flag.Parse()
	if *showVer {
		fmt.Println(version)
		return
	}

	log := slog.New(slog.NewTextHandler(os.Stderr, nil))
	if err := run(log, runOptions{listen: *listen, dataDir: *dataDir, ffmpeg: *ffmpeg, rtsp: *rtsp, mtxUser: *mtxUser, origins: *origins, certFile: *certFile, keyFile: *keyFile, mtxConf: *mtxConf, mtxBin: *mtxBin, mtxMirror: *mtxMirror}); err != nil {
		log.Error("agent stopped", "error", err)
		os.Exit(1)
	}
}

type runOptions struct {
	listen, dataDir, ffmpeg, rtsp, mtxUser, origins, certFile, keyFile string
	mtxConf, mtxBin, mtxMirror                                         string
}

func run(log *slog.Logger, o runOptions) error {
	listen, dataDir, ffmpeg, rtsp, mtxUser, origins, certFile, keyFile := o.listen, o.dataDir, o.ffmpeg, o.rtsp, o.mtxUser, o.origins, o.certFile, o.keyFile
	st, err := store.Open(dataDir)
	if err != nil {
		return err
	}
	token, err := loadToken(dataDir, log)
	if err != nil {
		return err
	}
	accounts, err := auth.Open(dataDir)
	if err != nil {
		return err
	}
	if !accounts.HasAccounts() {
		log.Warn("no panel account yet: open the panel and create it with the API token, or run: nodo-agent passwd <user>", "data", dataDir)
	}

	var mtx *mtxconf.Manager
	if o.mtxConf != "" {
		var validate mtxconf.Validator
		if o.mtxBin != "" {
			validate = mtxconf.MediaMTXValidator(o.mtxBin)
		}
		mtx, err = mtxconf.New(mtxconf.Paths{
			Base:    o.mtxConf,
			Overlay: filepath.Join(dataDir, "mediamtx", "overlay.yml"),
			Out:     filepath.Join(dataDir, "mediamtx", "mediamtx.yml"),
		}, validate)
		if err != nil {
			return err
		}
		if err := mtx.Regenerate(); err != nil {
			// A broken base must not stop the agent: the previous generated file stays in place.
			log.Warn("could not regenerate the MediaMTX configuration", "error", err)
		} else {
			log.Info("MediaMTX configuration generated", "file", filepath.Join(dataDir, "mediamtx", "mediamtx.yml"), "validated", o.mtxBin != "")
		}
	}

	// MediaMTX versions and, when there is a generated configuration, an optional supervised process.
	bins := binaries.New(filepath.Join(dataDir, "bin", "mediamtx"), binaries.Options{BaseURL: o.mtxMirror})
	var sup *supervisor.Supervisor
	supCtx, stopSup := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stopSup()
	if mtx != nil {
		sup = supervisor.New(supCtx, supervisor.Config{
			Binary:    bins.CurrentBinary,
			Args:      func() []string { return []string{mtx.OutPath()} },
			Dir:       filepath.Join(dataDir, "mediamtx"),
			StatePath: filepath.Join(dataDir, "mediamtx", "supervisor.json"),
			Log:       log,
		})
		sup.Restore()
		defer sup.Close()
	}

	// Host monitor: tool detection spawns processes, so it is cached; encoders are listed once, in the background.
	var (
		toolMu    sync.Mutex
		toolAt    time.Time
		toolCache []host.ToolPresence
		encoders  []string
		encMu     sync.Mutex
	)
	monitor := host.NewMonitor("/", 2*time.Second, func() []host.ToolPresence {
		toolMu.Lock()
		defer toolMu.Unlock()
		if time.Since(toolAt) > 30*time.Second {
			toolCache = toolCache[:0]
			for _, t := range binaries.Tools(ffmpeg) {
				toolCache = append(toolCache, host.ToolPresence{ID: t.ID, Found: t.Found})
			}
			toolAt = time.Now()
		}
		return append([]host.ToolPresence(nil), toolCache...)
	}, func() []string {
		encMu.Lock()
		defer encMu.Unlock()
		return encoders
	})
	go func() {
		list := host.Encoders(ffmpeg)
		encMu.Lock()
		encoders = list
		encMu.Unlock()
	}()
	go monitor.Run(supCtx)

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
		Handler:           api.New(api.Config{Token: token, AllowOrigins: splitList(origins), Info: info, Panel: web.Handler(), Accounts: accounts, MediaMTX: mtx, Binaries: bins, Supervisor: sup, FFmpeg: ffmpeg, Host: monitor}, mgr),
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
