import type { RawGlobalConf } from "./types";

export type UrlProtocol = "rtsp" | "rtmp" | "srt" | "hls" | "webrtc";

export interface UrlEntry {
  protocol: UrlProtocol;
  label: string;
  url: string;
}

interface Service {
  enabled: boolean;
  port: number | null;
  /** Port of the TLS variant, when the server has one (rtsps, rtmps). */
  securePort: number | null;
  /** The server only accepts the TLS variant. */
  strict: boolean;
}

export type Ports = Record<UrlProtocol, Service>;

/** Extracts the port from `:8554`, `0.0.0.0:8554`, `[::]:8554` or `8554`. */
export function parsePort(address: unknown): number | null {
  if (typeof address !== "string") return null;
  const match = /(?:^|:)(\d{1,5})$/.exec(address.trim());
  const port = match ? Number(match[1]) : NaN;
  return port > 0 && port < 65536 ? port : null;
}

const isStrict = (value: unknown) => value === true || value === "strict";

function service(conf: RawGlobalConf, key: string, secureKey?: string): Service {
  return {
    enabled: conf[key] !== false,
    port: parsePort(conf[`${key}Address`]),
    securePort: secureKey ? parsePort(conf[`${secureKey}Address`]) : null,
    strict: isStrict(conf[`${key}Encryption`]),
  };
}

/** Reads the listening ports and encryption mode from `/v3/config/global/get`. */
export function readPorts(conf: RawGlobalConf): Ports {
  return {
    rtsp: service(conf, "rtsp", "rtsps"),
    rtmp: service(conf, "rtmp", "rtmps"),
    srt: service(conf, "srt"),
    hls: service(conf, "hls"),
    webrtc: service(conf, "webrtc"),
  };
}

/** Hostname of the API URL in use; the media ports are served by the same host. */
export function hostOf(apiUrl: string): string {
  try {
    return new URL(apiUrl).hostname;
  } catch {
    return "";
  }
}

const encodePath = (name: string) => name.split("/").map(encodeURIComponent).join("/");

/**
 * Builds the read URLs of a channel with the ports of the server's global
 * configuration. Protocols that are disabled or have no port are left out.
 * SRT passphrases are never included.
 */
export function buildReadUrls(host: string, channel: string, ports: Ports): UrlEntry[] {
  const path = encodePath(channel);
  const entries: UrlEntry[] = [];

  const rtsp = ports.rtsp;
  if (rtsp.enabled) {
    const secure = rtsp.strict && rtsp.securePort;
    const port = secure ? rtsp.securePort : rtsp.port;
    if (port) entries.push({ protocol: "rtsp", label: "RTSP", url: `${secure ? "rtsps" : "rtsp"}://${host}:${port}/${path}` });
  }
  const rtmp = ports.rtmp;
  if (rtmp.enabled) {
    const secure = rtmp.strict && rtmp.securePort;
    const port = secure ? rtmp.securePort : rtmp.port;
    if (port) entries.push({ protocol: "rtmp", label: "RTMP", url: `${secure ? "rtmps" : "rtmp"}://${host}:${port}/${path}` });
  }
  const srt = ports.srt;
  if (srt.enabled && srt.port) {
    entries.push({ protocol: "srt", label: "SRT", url: `srt://${host}:${srt.port}?streamid=read:${path}` });
  }
  const hls = ports.hls;
  if (hls.enabled && hls.port) {
    entries.push({ protocol: "hls", label: "HLS", url: `${hls.strict ? "https" : "http"}://${host}:${hls.port}/${path}/index.m3u8` });
  }
  const webrtc = ports.webrtc;
  if (webrtc.enabled && webrtc.port) {
    entries.push({ protocol: "webrtc", label: "WebRTC", url: `${webrtc.strict ? "https" : "http"}://${host}:${webrtc.port}/${path}` });
  }
  return entries;
}
