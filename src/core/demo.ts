import type { HttpRequest, HttpResponse, Transport } from "./http";
import type { RawGlobalConf, RawPath, RawPathConf } from "./mediamtx/types";

/** Endpoint of the demo server. The transport answers by path and ignores the host. */
export const DEMO_API_URL = "https://demo.nodo.invalid";

interface DemoChannel {
  name: string;
  confName?: string;
  source: { type: string; id: string } | null;
  live: boolean;
  /** Video + audio bitrate in Mbps as seen by the server. */
  inMbps: number;
  readers: Array<{ type: string; id: string }>;
  tracks: RawPath["tracks2"];
}

const video1080 = { codec: "H264", codecProps: { width: 1920, height: 1080, profile: "High", level: "4.1" } };
const video720 = { codec: "H264", codecProps: { width: 1280, height: 720, profile: "High", level: "3.1" } };
const aac = { codec: "MPEG-4 Audio", codecProps: { sampleRate: 48000, channelCount: 2 } };

const CHANNELS: DemoChannel[] = [
  {
    name: "canal63", source: { type: "srtSource", id: "srt://127.0.0.1:3333" }, live: true, inMbps: 6.2,
    readers: [{ type: "webRTCSession", id: "a1" }, { type: "rtspSession", id: "b2" }, { type: "hlsSession", id: "c3" }],
    tracks: [video1080, aac],
  },
  {
    name: "canal63_720", source: { type: "rtspSession", id: "ffmpeg" }, live: true, inMbps: 2.5,
    readers: [{ type: "rtspSession", id: "d4" }, { type: "webRTCSession", id: "e5" }],
    tracks: [video720, aac],
  },
  {
    name: "canal65", confName: "all_others", source: { type: "rtmpConn", id: "f6" }, live: true, inMbps: 3.1,
    readers: [{ type: "hlsSession", id: "g7" }, { type: "srtConn", id: "h8" }],
    tracks: [video1080, aac],
  },
  { name: "camara_patio", source: null, live: false, inMbps: 0, readers: [], tracks: [] },
  { name: "prueba_hls", source: null, live: false, inMbps: 0, readers: [], tracks: [] },
];

const CONFS: RawPathConf[] = [
  { name: "canal63", source: "srt://127.0.0.1:3333?passphrase=demo" },
  { name: "canal63_720", source: "publisher" },
  { name: "camara_patio", source: "rtsp://192.168.1.60/stream" },
  { name: "prueba_hls", source: "publisher" },
  { name: "all_others" },
];

const GLOBAL: RawGlobalConf = {
  api: true, apiAddress: ":9997",
  rtsp: true, rtspAddress: ":8554", rtspsAddress: ":8322", rtspEncryption: "no",
  rtmp: true, rtmpAddress: ":1935", rtmpsAddress: ":1936", rtmpEncryption: "no",
  srt: true, srtAddress: ":8890",
  hls: true, hlsAddress: ":8888", hlsEncryption: false,
  webrtc: true, webrtcAddress: ":8889", webrtcEncryption: false,
};

const STARTED = Date.now() - 2 * 3600_000;

/**
 * In-memory stand-in for a MediaMTX v1.21 server, used by demo mode. Byte
 * counters grow with a slightly varying rate so bitrates look alive.
 */
export function createDemoTransport(now: () => number = Date.now): Transport {
  const bytesAt = (channel: DemoChannel, direction: "in" | "out", at: number): number => {
    if (!channel.live) return 0;
    const seconds = (at - STARTED) / 1000;
    const fan = direction === "out" ? Math.max(1, channel.readers.length) : 1;
    const wobble = 1 + 0.06 * Math.sin(at / 4000) + 0.03 * Math.sin(at / 1300);
    const rate = (channel.inMbps * 1e6) / 8;
    // Integral of rate × wobble is approximated by rate × seconds; the wobble only
    // perturbs the slope between polls.
    return Math.floor(rate * fan * (seconds + 20 * wobble));
  };

  const paths = (): RawPath[] => {
    const at = now();
    return CHANNELS.filter((c) => c.live).map((c) => ({
      name: c.name,
      confName: c.confName ?? c.name,
      source: c.source,
      available: true,
      online: true,
      tracks2: c.tracks,
      inboundBytes: bytesAt(c, "in", at),
      outboundBytes: bytesAt(c, "out", at),
      onlineTime: new Date(STARTED).toISOString(),
      readers: c.readers,
      readerCount: c.readers.length,
    }));
  };

  const page = <T>(items: T[]) => ({ itemCount: items.length, pageCount: 1, items });

  return async (request: HttpRequest): Promise<HttpResponse> => {
    const path = new URL(request.url).pathname;
    const ok = (data: unknown): HttpResponse => ({ status: 200, ok: true, data });
    switch (path) {
      case "/v3/info":
        return ok({ version: "v1.21.4", started: new Date(STARTED).toISOString() });
      case "/v3/config/global/get":
        return ok(GLOBAL);
      case "/v3/config/paths/list":
        return ok(page(CONFS));
      case "/v3/paths/list":
        return ok(page(paths()));
      default:
        return { status: 404, ok: false, data: { error: "not found" } };
    }
  };
}
