/** Raw shapes returned by the MediaMTX Control API. Everything is optional: fields differ between versions. */

export interface RawTrack {
  codec: string;
  codecProps?: Record<string, unknown> | null;
}

export interface RawPath {
  name: string;
  confName?: string;
  source?: { type?: string; id?: string } | null;
  // v1.21+
  available?: boolean;
  online?: boolean;
  tracks2?: RawTrack[];
  inboundBytes?: number;
  outboundBytes?: number;
  onlineTime?: string | null;
  availableTime?: string | null;
  // older servers (still sent by newer ones, marked deprecated)
  ready?: boolean;
  readyTime?: string | null;
  tracks?: string[];
  bytesReceived?: number;
  bytesSent?: number;
  readers?: Array<{ type?: string; id?: string }>;
  readerCount?: number;
}

export interface RawPathConf {
  /** Missing in the path defaults, which belong to no path. */
  name?: string;
  source?: string;
  [key: string]: unknown;
}

export interface RawPage<T> {
  itemCount?: number;
  pageCount?: number;
  items?: T[];
}

export interface RawGlobalConf {
  [key: string]: unknown;
}

export interface RawInfo {
  version?: string;
  started?: string;
}

// ---- normalized model used by the UI ----

export type TrackKind = "video" | "audio" | "other";

export interface Track {
  kind: TrackKind;
  codec: string;
  /** Human-readable detail such as "1920×1080" or "48 kHz · 2 ch". */
  detail: string;
}

export interface Reader {
  type: string;
  id: string;
}

export interface Channel {
  name: string;
  /** Path configuration that matches this channel (equals `name` when explicitly configured). */
  confName: string;
  /** `configured`: has its own entry; `dynamic`: created on demand by `all_others` or a regex path. */
  kind: "configured" | "dynamic";
  /** A publisher or source is connected and sending. */
  live: boolean;
  source: { type: string; id: string } | null;
  readers: Reader[];
  readerCount: number;
  tracks: Track[];
  bytesIn: number;
  bytesOut: number;
  /** ISO timestamp since the channel went live, if known. */
  liveSince: string | null;
}
