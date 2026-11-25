import type { default as HlsType } from "hls.js";

export type HlsFailure = "unavailable" | "unauthorized" | "network" | "unsupported" | "media";

export interface HlsOptions {
  video: HTMLVideoElement;
  /** `http(s)://host:8888/<path>/index.m3u8` */
  url: string;
  headers?: Record<string, string>;
  onPlaying?: () => void;
  onError: (kind: HlsFailure) => void;
  /** Injected in tests. */
  loadHls?: () => Promise<{ default: typeof HlsType }>;
}

/** Maps the HTTP status hls.js reports for a failed request to what the user should be told. */
export function failureFromStatus(status: number | undefined): HlsFailure {
  if (status === 404) return "unavailable";
  if (status === 401 || status === 403) return "unauthorized";
  return "network";
}

/**
 * Plays an HLS URL. hls.js is loaded on demand (it is bigger than the whole panel shell); Safari plays
 * HLS natively, which cannot send an Authorization header, so it is only used when none is needed.
 */
export async function startHls(options: HlsOptions): Promise<() => void> {
  const { video, url, headers } = options;
  const needsHeaders = headers && Object.keys(headers).length > 0;
  const load = options.loadHls ?? (() => import("hls.js"));
  const { default: Hls } = await load();

  if (!Hls.isSupported()) {
    if (!needsHeaders && video.canPlayType("application/vnd.apple.mpegurl")) {
      video.src = url;
      video.addEventListener("playing", () => options.onPlaying?.(), { once: true });
      void video.play().catch(() => undefined);
      return () => {
        video.removeAttribute("src");
        video.load();
      };
    }
    throw Object.assign(new Error("HLS is not supported"), { kind: "unsupported" as HlsFailure });
  }

  const hls = new Hls({
    lowLatencyMode: true,
    xhrSetup: (xhr) => {
      for (const [name, value] of Object.entries(headers ?? {})) xhr.setRequestHeader(name, value);
    },
  });
  hls.on(Hls.Events.ERROR, (_event, data) => {
    if (!data.fatal) return;
    const status = (data.response as { code?: number } | undefined)?.code;
    options.onError(data.type === Hls.ErrorTypes.MEDIA_ERROR ? "media" : failureFromStatus(status));
    hls.destroy();
  });
  video.addEventListener("playing", () => options.onPlaying?.(), { once: true });
  hls.loadSource(url);
  hls.attachMedia(video);
  void video.play().catch(() => undefined);
  return () => hls.destroy();
}
