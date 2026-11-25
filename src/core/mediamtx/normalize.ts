import type { Channel, RawPath, RawPathConf, RawTrack, Reader, Track, TrackKind } from "./types";

const VIDEO_CODECS = new Set([
  "AV1", "VP9", "VP8", "H265", "H264", "MPEG-4 Video", "MPEG-1/2 Video", "M-JPEG",
]);
const AUDIO_CODECS = new Set([
  "Opus", "FLAC", "Vorbis", "MPEG-4 Audio", "MPEG-4 Audio LATM", "MPEG-1/2 Audio",
  "AC3", "Speex", "G726", "G722", "G711", "LPCM",
]);

function trackKind(codec: string): TrackKind {
  if (VIDEO_CODECS.has(codec)) return "video";
  if (AUDIO_CODECS.has(codec)) return "audio";
  return "other";
}

const num = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

function trackDetail(raw: RawTrack): string {
  const props = raw.codecProps ?? {};
  const width = num(props.width);
  const height = num(props.height);
  const parts: string[] = [];
  if (width && height) parts.push(`${width}×${height}`);
  const rate = num(props.sampleRate);
  if (rate) parts.push(`${rate / 1000} kHz`.replace(".0 ", " "));
  const channels = num(props.channelCount);
  if (channels) parts.push(`${channels} ch`);
  if (typeof props.profile === "string" && props.profile) parts.push(props.profile);
  return parts.join(" · ");
}

/** Reads `tracks2` (v1.21+) and falls back to the plain codec names of older servers. */
export function normalizeTracks(raw: RawPath): Track[] {
  const list: RawTrack[] = raw.tracks2 ?? (raw.tracks ?? []).map((codec) => ({ codec }));
  return list.map((t) => ({ kind: trackKind(t.codec), codec: t.codec, detail: trackDetail(t) }));
}

function normalizeReaders(raw: RawPath): Reader[] {
  return (raw.readers ?? []).map((r) => ({ type: r.type ?? "unknown", id: r.id ?? "" }));
}

/**
 * Converts one runtime path (`/v3/paths/list`) into the UI model.
 * `online` replaces `ready` in newer versions; bytes moved from `bytesReceived/Sent`
 * to `inboundBytes/outboundBytes`.
 */
export function normalizePath(raw: RawPath): Channel {
  const confName = raw.confName ?? raw.name;
  const readers = normalizeReaders(raw);
  return {
    name: raw.name,
    confName,
    kind: confName === raw.name ? "configured" : "dynamic",
    live: raw.online ?? raw.ready ?? false,
    source: raw.source ? { type: raw.source.type ?? "unknown", id: raw.source.id ?? "" } : null,
    readers,
    readerCount: raw.readerCount ?? readers.length,
    tracks: normalizeTracks(raw),
    bytesIn: raw.inboundBytes ?? raw.bytesReceived ?? 0,
    bytesOut: raw.outboundBytes ?? raw.bytesSent ?? 0,
    liveSince: raw.onlineTime ?? raw.readyTime ?? null,
  };
}

/** Pattern entries (`all_others`, `~regex`) describe paths that do not exist yet. */
export function isPatternConf(name: string): boolean {
  return name === "all_others" || name === "all" || name.startsWith("~");
}

/**
 * Joins runtime paths with the configured ones. A configured path with no
 * publisher is not in the runtime list, so it is added here as offline.
 * Live channels come first, then alphabetical (numeric-aware).
 */
export function mergeChannels(runtime: Channel[], confs: RawPathConf[] | null): Channel[] {
  const byName = new Map(runtime.map((c) => [c.name, c]));
  for (const conf of confs ?? []) {
    const name = conf.name;
    if (!name || isPatternConf(name) || byName.has(name)) continue;
    byName.set(name, {
      name,
      confName: name,
      kind: "configured",
      live: false,
      source: null,
      readers: [],
      readerCount: 0,
      tracks: [],
      bytesIn: 0,
      bytesOut: 0,
      liveSince: null,
    });
  }
  return [...byName.values()].sort(
    (a, b) => Number(b.live) - Number(a.live) || a.name.localeCompare(b.name, undefined, { numeric: true }),
  );
}
