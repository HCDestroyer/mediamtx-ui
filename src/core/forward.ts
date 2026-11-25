/**
 * Destinations of MediaMTX's native `forward` list (stream copy to RTMP, RTSP,
 * SRT, WHIP or MoQ servers). Stream keys travel in the URL: `rtmp://host/app#KEY`.
 */

export type ForwardKind = "RTMP" | "RTSP" | "SRT" | "WHIP" | "MoQ";

const SCHEMES: Array<[RegExp, ForwardKind]> = [
  [/^rtmps?:\/\//i, "RTMP"],
  [/^rtsps?:\/\//i, "RTSP"],
  [/^srt:\/\//i, "SRT"],
  [/^whips?:\/\//i, "WHIP"],
  [/^moqt:\/\//i, "MoQ"],
];

export function forwardKind(dest: string): ForwardKind | null {
  return SCHEMES.find(([re]) => re.test(dest.trim()))?.[1] ?? null;
}

export type DestinationError = "required" | "scheme" | "host";

export function validateDestination(dest: string): DestinationError | null {
  const text = dest.trim();
  if (!text) return "required";
  if (!forwardKind(text)) return "scheme";
  try {
    return new URL(text).hostname ? null : "host";
  } catch {
    return "host";
  }
}

export interface ForwardPreset {
  id: "youtube" | "facebook" | "twitch" | "custom";
  label: string;
  /** Server part of the URL; the user adds the stream key. Empty for a custom destination. */
  base: string;
}

// Ingest URLs change from time to time: the form tells the user to check them on the platform.
export const FORWARD_PRESETS: readonly ForwardPreset[] = [
  { id: "youtube", label: "YouTube", base: "rtmps://a.rtmps.youtube.com:443/live2" },
  { id: "facebook", label: "Facebook", base: "rtmps://live-api-s.facebook.com:443/rtmp" },
  { id: "twitch", label: "Twitch", base: "rtmp://live.twitch.tv/app" },
  { id: "custom", label: "RTMP / SRT / otro", base: "" },
];

/** Joins the platform URL and the key the way MediaMTX expects: `base#key`. */
export const destinationFromKey = (base: string, key: string): string => `${base}#${key.trim()}`;

/** Splits `base#key` back into its two parts (the key is empty when there is none). */
export function splitDestination(dest: string): { base: string; key: string } {
  const index = dest.indexOf("#");
  return index < 0 ? { base: dest, key: "" } : { base: dest.slice(0, index), key: dest.slice(index + 1) };
}

/** URL safe to show: no password, passphrase or stream key. */
export function maskDestination(dest: string): string {
  return dest
    .replace(/(:\/\/[^/:@\s]+:)[^@/\s]+@/, "$1••••@")
    .replace(/([?&]passphrase=)[^&#\s]*/, "$1••••")
    .replace(/#.+$/, "#••••");
}

export interface ForwardEntry {
  dest: string;
  destFingerprint?: string;
  moqTransport?: string;
  whipBearerToken?: string;
}

/** Normalizes the list the API returns (items without a destination are dropped). */
export function readForwardList(value: unknown): ForwardEntry[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): ForwardEntry[] => {
    if (typeof item !== "object" || item === null) return [];
    const entry = item as Record<string, unknown>;
    return typeof entry.dest === "string" && entry.dest !== "" ? [item as ForwardEntry] : [];
  });
}
