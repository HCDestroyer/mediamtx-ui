import type { HttpRequest, HttpResponse, Transport } from "./http";
import type { RawGlobalConf, RawPath, RawPathConf, RawTrack } from "./mediamtx/types";
import { buildFfmpegCommand, RESOLUTIONS } from "./transcode";

/** Endpoint of the demo server. The transport answers by path and ignores the host. */
export const DEMO_API_URL = "https://demo.nodo.invalid";

const video1080: RawTrack = { codec: "H264", codecProps: { width: 1920, height: 1080, profile: "High", level: "4.1" } };
const video720: RawTrack = { codec: "H264", codecProps: { width: 1280, height: 720, profile: "High", level: "3.1" } };
const aac: RawTrack = { codec: "MPEG-4 Audio", codecProps: { sampleRate: 48000, channelCount: 2 } };

/** A stream the simulator can play. It is live only while its path exists (or is dynamic). */
interface Stream {
  name: string;
  /** Created on demand by `all_others`: has no entry of its own. */
  dynamic?: boolean;
  source: { type: string; id: string };
  inMbps: number;
  readers: Array<{ type: string; id: string }>;
  tracks: RawTrack[];
}

const STREAMS: Stream[] = [
  {
    name: "canal63", source: { type: "srtSource", id: "srt://127.0.0.1:3333" }, inMbps: 6.2,
    readers: [{ type: "webRTCSession", id: "a1" }, { type: "rtspSession", id: "b2" }, { type: "hlsSession", id: "c3" }],
    tracks: [video1080, aac],
  },
  {
    name: "canal65", dynamic: true, source: { type: "rtmpConn", id: "f6" }, inMbps: 3.1,
    readers: [{ type: "hlsSession", id: "g7" }, { type: "srtConn", id: "h8" }],
    tracks: [video1080, aac],
  },
];

/** What a path gets when it is not configured otherwise; shaped like `/v3/config/path-defaults/get`. */
const DEFAULTS: RawPathConf = {
  source: "publisher", sourceFingerprint: "", sourceOnDemand: false, sourceOnDemandStartTimeout: "10s",
  sourceOnDemandCloseAfter: "10s", maxReaders: 0, srtReadPassphrase: "", srtPublishPassphrase: "",
  alwaysAvailable: false, forward: [], record: false, recordPath: "./recordings/%path/%Y-%m-%d_%H-%M-%S-%f_%z",
  recordFormat: "fmp4", recordPartDuration: "1s", recordSegmentDuration: "1h", recordDeleteAfter: "1d",
  overridePublisher: true, runOnInit: "", runOnInitRestart: false, runOnDemand: "", runOnOnline: "",
  runOnOnlineRestart: false, runOnOffline: "", runOnAvailable: "", runOnAvailableRestart: false,
  runOnReady: null, runOnReadyRestart: null, runOnNotReady: null,
};

/** `canal63` already feeds a 720p copy, as it would after running the transcode wizard. */
const INITIAL_CONFS: Record<string, RawPathConf> = {
  canal63: {
    source: "srt://127.0.0.1:3333?passphrase=demo-passphrase-1",
    runOnOnline: buildFfmpegCommand({ origin: "canal63", resolution: RESOLUTIONS[1]!, encoder: "libx264", rtspPort: 8554 }),
    runOnOnlineRestart: true,
  },
  canal63_720: { source: "publisher" },
  camara_patio: { source: "publisher" },
  prueba_hls: { source: "publisher" },
  all_others: { source: "publisher" },
};

const GLOBAL: RawGlobalConf = {
  api: true, apiAddress: ":9997",
  rtsp: true, rtspAddress: ":8554", rtspsAddress: ":8322", rtspEncryption: "no",
  rtmp: true, rtmpAddress: ":1935", rtmpsAddress: ":1936", rtmpEncryption: "no",
  srt: true, srtAddress: ":8890",
  hls: true, hlsAddress: ":8888", hlsEncryption: false,
  webrtc: true, webrtcAddress: ":8889", webrtcEncryption: false,
};

const STARTED = Date.now() - 2 * 3600_000;

/** Source type MediaMTX would report for a pulled URL. */
function sourceTypeOf(url: string): string {
  if (/^srt:/i.test(url)) return "srtSource";
  if (/^rtmps?:/i.test(url)) return "rtmpSource";
  if (/^https?:/i.test(url)) return "hlsSource";
  if (/^udp\+mpegts:/i.test(url)) return "mpegtsSource";
  if (/^udp\+rtp:/i.test(url)) return "rtpSource";
  if (/^wheps?:/i.test(url)) return "webRTCSource";
  return "rtspSource";
}

const hookOf = (conf: RawPathConf): string => String(conf.runOnOnline || conf.runOnReady || "");

/**
 * In-memory stand-in for a MediaMTX v1.21 server, used by demo mode. Path
 * configuration is writable, and streams follow it: a pulled source is live, and
 * the destination of a transcode hook comes alive while its origin is.
 * Byte counters grow with a slightly varying rate so bitrates look alive.
 */
export function createDemoTransport(now: () => number = Date.now): Transport {
  const confs: Record<string, RawPathConf> = structuredClone(INITIAL_CONFS);

  const fullConf = (name: string): RawPathConf => ({ ...DEFAULTS, ...confs[name], name });

  /** Streams that are live right now, by path name. */
  /** Connections the operator kicked out; they do not come back. */
  const kicked = new Set<string>();

  const liveStreams = (): Stream[] => {
    const live = new Map<string, Stream>();
    for (const stream of STREAMS) {
      // A kicked publisher takes its dynamic channel down; a kicked reader just leaves.
      if (stream.dynamic && kicked.has(stream.source.id)) continue;
      if (stream.dynamic || confs[stream.name]) live.set(stream.name, { ...stream, readers: stream.readers.filter((r) => !kicked.has(r.id)) });
    }
    // A path that pulls from a URL is live.
    for (const [name, conf] of Object.entries(confs)) {
      const source = String(conf.source ?? "publisher");
      if (live.has(name) || name === "all_others" || name.startsWith("~")) continue;
      if (source !== "publisher" && source !== "redirect" && source !== "rpiCamera") {
        live.set(name, {
          name, source: { type: sourceTypeOf(source), id: source },
          inMbps: 2.2, readers: [], tracks: [video720, aac],
        });
      }
    }
    // The output of a transcode hook is live while the origin is.
    for (const [origin, conf] of Object.entries(confs)) {
      if (!live.has(origin)) continue;
      const match = /-f rtsp -rtsp_transport tcp rtsp:\/\/127\.0\.0\.1:\d+\/(\S+)/.exec(hookOf(conf));
      const destination = match?.[1];
      if (destination && confs[destination] && !live.has(destination)) {
        live.set(destination, {
          name: destination, source: { type: "rtspSession", id: "ffmpeg" }, inMbps: 2.5,
          readers: [{ type: "rtspSession", id: "d4" }, { type: "webRTCSession", id: "e5" }], tracks: [video720, aac],
        });
      }
    }
    return [...live.values()];
  };

  const bytesAt = (stream: Stream, direction: "in" | "out", at: number): number => {
    const seconds = (at - STARTED) / 1000;
    const fan = direction === "out" ? Math.max(1, stream.readers.length) : 1;
    const wobble = 1 + 0.06 * Math.sin(at / 4000) + 0.03 * Math.sin(at / 1300);
    return Math.floor(((stream.inMbps * 1e6) / 8) * fan * (seconds + 20 * wobble));
  };

  const paths = (): RawPath[] => {
    const at = now();
    return liveStreams().map((s) => ({
      name: s.name,
      confName: s.dynamic && !confs[s.name] ? "all_others" : s.name,
      source: s.source,
      available: true,
      online: true,
      tracks2: s.tracks,
      inboundBytes: bytesAt(s, "in", at),
      outboundBytes: bytesAt(s, "out", at),
      onlineTime: new Date(STARTED).toISOString(),
      readers: s.readers,
      readerCount: s.readers.length,
    }));
  };

  /** Client connections, derived from who publishes and reads each live stream. */
  const PROTO_OF: Record<string, string> = {
    rtspSession: "rtsp", rtspsSession: "rtsps", rtmpConn: "rtmp", rtmpsConn: "rtmps",
    srtConn: "srt", webRTCSession: "webrtc", hlsSession: "hls",
  };
  const connections = (): Array<{ proto: string; raw: Record<string, unknown> }> => {
    const at = now();
    const out: Array<{ proto: string; raw: Record<string, unknown> }> = [];
    for (const stream of liveStreams()) {
      const add = (ref: { type: string; id: string }, publisher: boolean) => {
        const proto = PROTO_OF[ref.type];
        if (!proto) return; // pulled sources (srtSource, ...) are not client connections
        const seed = [...ref.id].reduce((sum, ch) => sum + ch.charCodeAt(0), 0);
        const bytes = bytesAt(stream, "in", at);
        out.push({
          proto,
          raw: {
            id: ref.id, created: new Date(STARTED + 600_000 * ((seed % 9) + 1)).toISOString(),
            remoteAddr: `192.168.1.${10 + (seed % 200)}:${40_000 + ((seed * 7) % 20_000)}`,
            path: stream.name, query: "", user: "",
            inboundBytes: publisher ? bytes : 1_000, outboundBytes: publisher ? 0 : bytes,
            ...(proto === "srt" ? { msRTT: 8 + (seed % 20), packetsReceived: 1_000_000, packetsReceivedLoss: seed % 40 } : {}),
            ...(proto === "rtsp" ? { transport: seed % 2 ? "tcp" : "udp" } : {}),
          },
        });
      };
      add(stream.source, true);
      for (const reader of stream.readers) add(reader, false);
    }
    return out;
  };

  const page = <T>(items: T[]) => ({ itemCount: items.length, pageCount: 1, items });
  const ok = (data: unknown = null): HttpResponse => ({ status: 200, ok: true, data });
  const fail = (status: number, error: string): HttpResponse => ({ status, ok: false, data: { error } });

  return async (request: HttpRequest): Promise<HttpResponse> => {
    const url = new URL(request.url);
    const method = request.method ?? "GET";
    const confMatch = /^\/v3\/config\/paths\/(get|add|patch|delete)\/(.+)$/.exec(url.pathname);

    if (confMatch) {
      const action = confMatch[1]!;
      const name = decodeURIComponent(confMatch[2]!);
      if (action === "get") return confs[name] ? ok(fullConf(name)) : fail(404, `path configuration '${name}' not found`);
      if (action === "add") {
        if (confs[name]) return fail(400, `path '${name}' is already defined`);
        confs[name] = { ...((request.body as RawPathConf | undefined) ?? {}) };
        return ok();
      }
      if (action === "patch") {
        if (!confs[name]) return fail(404, `path configuration '${name}' not found`);
        confs[name] = { ...confs[name], ...((request.body as RawPathConf | undefined) ?? {}) };
        return ok();
      }
      if (!confs[name]) return fail(404, `path configuration '${name}' not found`);
      delete confs[name];
      return ok();
    }

    const kick = /^\/v3\/(rtsp|rtsps|rtmp|rtmps|srt|webrtc|hls)\/(?:sessions|conns)\/kick\/(.+)$/.exec(url.pathname);
    if (kick && method === "POST") {
      const id = decodeURIComponent(kick[2]!);
      if (!connections().some((c) => c.proto === kick[1] && c.raw.id === id)) return fail(404, "connection not found");
      kicked.add(id);
      return ok();
    }

    if (method !== "GET") return fail(404, "not found");

    const list = /^\/v3\/(rtsp|rtsps|rtmp|rtmps|srt|webrtc|hls)\/(?:sessions|conns)\/list$/.exec(url.pathname);
    if (list) return ok(page(connections().filter((c) => c.proto === list[1]).map((c) => c.raw)));

    switch (url.pathname) {
      case "/v3/info":
        return ok({ version: "v1.21.4", started: new Date(STARTED).toISOString() });
      case "/v3/config/global/get":
        return ok(GLOBAL);
      case "/v3/config/path-defaults/get":
        return ok(DEFAULTS);
      case "/v3/config/paths/list":
        return ok(page(Object.keys(confs).map(fullConf)));
      case "/v3/paths/list":
        return ok(page(paths()));
      case "/v3/paths/forward-dests/list": {
        const name = url.searchParams.get("path") ?? "";
        if (!confs[name]) return fail(404, `path '${name}' not found`);
        const live = liveStreams().some((s) => s.name === name);
        const list = (confs[name]!.forward as Array<{ dest?: string }> | undefined) ?? [];
        return ok(page(list.map((entry, index) => ({
          id: `fwd-${name}-${index}`, pos: index + 1, type: /^srt/.test(entry.dest ?? "") ? "srt" : "rtmp",
          state: !live ? "idle" : /fail|error/i.test(entry.dest ?? "") ? "error" : "forwarding",
          lastError: /fail|error/i.test(entry.dest ?? "") ? "dial tcp: connection refused" : "",
          outboundBytes: live ? 4_000_000 * (index + 1) : 0,
        }))));
      }
      default:
        return fail(404, "not found");
    }
  };
}
