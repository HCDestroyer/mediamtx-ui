# nodo-agent

Runs transport-stream **services** on a host, in the spirit of an Astra stream: one or more
inputs with automatic backup, a stabilizer that keeps the structure of the output fixed, and
outputs. The Nodo panel drives it through an HTTP API.

Only the Go standard library is used. FFmpeg is optional and acts purely as a protocol adapter
(`-c copy`), so it costs almost no CPU.

## What a service does

```
inputs ──► [active input] ──► stabilizer ──► outputs
 backup        │                 │
 failover      └─ PSI/PIDs       └─ fixed service id, PAT/PMT/SDT, PIDs and continuity counters
```

- **Stable structure.** Each output PID is fed by a *selector* (video; audio in `spa`; the second
  audio…), not by a PID number. When the source renumbers its streams or reorders its languages, or
  when the service fails over to another input, the output keeps the same service number, PIDs and
  tables, and its continuity counters stay unbroken. The PMT version only changes when the content
  of the output PMT changes.
- **Hot changes.** Editing the profile (PIDs, selectors, CBR) of a running service takes effect
  without restarting it.
- **Backup.** `active` mode watches every input; if the active one stays silent past its timeout the
  next one with data takes over, and the preferred one returns after it has been healthy for
  `returnDelaySec`. `manual` mode only switches on request. A switch marks a discontinuity on the clock.
- **Missing streams.** An output PID with no matching source stays listed in the PMT and sends no
  packets; the status says `missing` (or `fallback` when another stream of the same kind stands in).
- **CBR.** `cbrKbps` pads with null packets up to a constant bitrate.

## Addresses

`type://address#options`, options separated by `&`.

| Input | Notes |
| --- | --- |
| `udp://[iface@]group:port#pnr=100` | Multicast or unicast; `pnr` selects a program of an MPTS |
| `rtp://…` | RTP-wrapped MPEG-TS |
| `http://host/stream.ts` | MPEG-TS over HTTP (an `.m3u8` goes through FFmpeg) |
| `mediamtx://<path>` | A MediaMTX path, read over RTSP: **MediaMTX pulls any protocol** (SRT, HLS, RTMP, WebRTC…) |
| `rtsp://`, `rtmp://`, `srt://` | Read through FFmpeg |
| `file:///path.ts#rate=4000` | Looped file at a constant rate (tests and demos) |

| Output | Notes |
| --- | --- |
| `udp://[iface@]group:port#ttl=32&pkt=7` | Multicast TTL and packets per datagram |
| `rtp://…` | RTP payload type 33 |
| `mediamtx://<path>` | Publishes into MediaMTX, which then serves RTSP, RTMP, SRT, HLS and WebRTC and can forward to other servers |
| `rtmp://`, `rtmps://`, `srt://`, `rtsp://` | Published through FFmpeg |
| `file:///path.ts` | Diagnostics |

`mediamtx://` needs `-mediamtx-rtsp`, plus `-mediamtx-user` and `NODO_MEDIAMTX_PASS` when MediaMTX asks
for credentials. Credentials appear in the FFmpeg command line, so use a MediaMTX user that can only
publish and read.

## One binary, its own web server

Like Astra, the agent is a single file that serves the Nodo panel and the API on the same port, so
there is nothing else to host and no CORS or mixed-content issues between panel and agent.

The built panel is committed in `internal/web/dist`, so a plain `go build ./cmd/nodo-agent` already
produces the full installable (no Node needed). From a release tarball:

```bash
tar xzf nodo-agent_<version>_linux_amd64.tar.gz && cd nodo-agent_*/
sudo ./install.sh                 # installs /usr/bin/nodo-agent, registers service "nodo" on port 9980, starts it
```

or by hand:

```bash
sudo cp nodo-agent /usr/bin/nodo-agent
sudo nodo-agent init              # systemd service "nodo", port 9980, data in /etc/nodo/nodo
sudo systemctl enable --now nodo
sudo cat /etc/nodo/nodo/token     # API token for the panel
```

Maintainers: after changing `src/`, run `scripts/build-agent.sh` (rebuilds the panel into `dist/`, then the
binary; `--panel-only` skips the binary) and commit `agent/internal/web/dist`. `scripts/release.sh [version]`
writes the Linux amd64/arm64 tarballs and `SHA256SUMS` to `release/`. A test fails if the embedded panel is
missing or incomplete.

Open `http://<server>:9980`, add this server and fill in "Agente (opcional)" with `<server>:9980` and the
token. `nodo-agent init 9981 nodo2` adds a second, independent instance; `init -print` shows the unit
without installing it. To update: replace the binary and `systemctl restart nodo`. To back up:
`tar -Pzcf nodo-backup.tar.gz /usr/bin/nodo-agent /etc/nodo`.

## Run by hand

```bash
go build -o nodo-agent ./cmd/nodo-agent
./nodo-agent -listen 127.0.0.1:9980 -data /var/lib/nodo \
  -mediamtx-rtsp rtsp://127.0.0.1:8554 -mediamtx-user agent
```

The API token is created on first run in `<data>/token` (mode 0600) or taken from `NODO_TOKEN`.
It is never logged. Keep the API on localhost or behind a firewall/VPN; add `-tls-cert`/`-tls-key`
when it crosses a network.

## API

All `/api/v1` routes need `Authorization: Bearer <token>`.

| Route | |
| --- | --- |
| `GET /api/v1/info` | version, FFmpeg found |
| `GET /api/v1/services` | every service with its status |
| `POST /api/v1/services` | create (the id is derived from the name when omitted) |
| `GET/PUT/DELETE /api/v1/services/{id}` | read, replace, delete |
| `POST /api/v1/services/{id}/enable` · `/disable` | start / stop |
| `POST /api/v1/services/{id}/switch` | `{"input": 1}` (0-based) |

```json
{
  "name": "Deportes HD", "enabled": true,
  "inputs": [{"url": "udp://eth0@239.255.1.1:1234#pnr=100", "timeoutSec": 5}, {"url": "mediamtx://respaldo"}],
  "backup": {"mode": "active", "returnDelaySec": 30},
  "profile": {"serviceId": 100, "pmtPid": 4096, "name": "Deportes HD", "provider": "Nodo", "cbrKbps": 4000,
    "streams": [
      {"pid": 256, "kind": "video"},
      {"pid": 257, "kind": "audio", "lang": "spa", "fallbackAny": true},
      {"pid": 258, "kind": "audio", "lang": "eng"}]},
  "outputs": [{"url": "udp://239.255.10.1:1234#ttl=32"}, {"url": "mediamtx://deportes"}]
}
```

Services are saved in `<data>/services.json`, written atomically.

## Test

```bash
go test -race ./...
```

Several tests generate real transport streams with FFmpeg (skipped when it is missing): two sources
with different PIDs and language order, failing and returning, while a downstream analyzer checks
that the output structure and continuity never change.

## Not done yet

Panel login (user and password validated by the agent; today the panel uses the API token), passive backup mode, DVB input (TBS cards), SDT/NIT for multi-service output, a slate (screensaver)
for missing streams, SRT without FFmpeg.
