import { useCallback, useEffect, useRef, useState } from "react";
import { Button, Chip } from "@heroui/react";
import { Play, Square } from "lucide-react";
import { basicAuthHeader, isMixedContentBlocked } from "../core/http";
import { hostOf } from "../core/mediamtx/urls";
import { createDemoStream } from "../core/preview/demoStream";
import { startHls } from "../core/preview/hls";
import { startWhep, WhepError } from "../core/preview/whep";
import { useActiveServer } from "../hooks/useActiveConnection";
import { fmt, t } from "../i18n/es";
import { useChannels } from "../store/channels";

type Mode = "webrtc" | "hls";
type Phase = "idle" | "starting" | "playing" | "error";

const modeName = (mode: Mode) => (mode === "webrtc" ? t.detail.preview.modeWebrtc : t.detail.preview.modeHls);
const encodePath = (name: string) => name.split("/").map(encodeURIComponent).join("/");

/**
 * Live preview of a channel, straight from the media server: WebRTC (WHEP) for low latency, HLS as the
 * compatible fallback. Nothing is requested until the user asks.
 */
export function ChannelPreview({ channel, live }: { channel: string; live: boolean }) {
  const { server, connection } = useActiveServer();
  const ports = useChannels((s) => s.ports);
  const videoRef = useRef<HTMLVideoElement>(null);
  const stopRef = useRef<(() => void | Promise<void>) | null>(null);
  const run = useRef(0);
  const [mode, setMode] = useState<Mode>("webrtc");
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [showHlsHint, setShowHlsHint] = useState(false);

  const stop = useCallback(async () => {
    run.current += 1; // invalidates any start still in flight
    const stopper = stopRef.current;
    stopRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    await stopper?.();
    setPhase("idle");
  }, []);

  // Leaving the page, or switching channel or server, ends the preview.
  useEffect(() => () => void stop(), [stop, channel, server?.id]);

  const host = connection.active ? hostOf(connection.active.endpoint.apiUrl) : "";
  const service = ports?.[mode];
  const url = !service?.port || !host
    ? null
    : mode === "webrtc"
      ? `${service.strict ? "https" : "http"}://${host}:${service.port}/${encodePath(channel)}/whep`
      : `${service.strict ? "https" : "http"}://${host}:${service.port}/${encodePath(channel)}/index.m3u8`;
  const unavailable = !server?.demo && (!service?.enabled || !url);

  const start = async () => {
    await stop();
    const mine = run.current;
    const stale = () => run.current !== mine;
    setError(null);
    setShowHlsHint(false);
    setPhase("starting");
    const video = videoRef.current;
    if (!video) return;

    const fail = (kind: string, text?: string) => {
      if (stale()) return;
      setPhase("error");
      setError(text ?? (t.detail.preview.errors as Record<string, string>)[kind] ?? t.detail.preview.errors.network);
      setShowHlsHint(mode === "webrtc" && kind !== "unauthorized");
    };

    if (server?.demo) {
      const demo = createDemoStream(channel);
      stopRef.current = demo.stop;
      video.srcObject = demo.stream;
      void video.play().catch(() => undefined);
      setPhase("playing");
      return;
    }
    if (!url) return fail("network");
    if (isMixedContentBlocked(url)) return fail("mixed", t.detail.preview.errors.mixed);

    const headers = server?.username ? { Authorization: basicAuthHeader(server.username, server.password) } : undefined;
    try {
      if (mode === "webrtc") {
        const session = await startWhep({
          url,
          headers,
          onStream: (stream) => {
            if (stale()) return;
            video.srcObject = stream;
            void video.play().catch(() => undefined);
            setPhase("playing");
          },
          onState: () => fail("dropped"),
        });
        if (stale()) {
          await session.stop();
          return;
        }
        stopRef.current = () => session.stop();
      } else {
        const stopHls = await startHls({
          video,
          url,
          headers,
          onPlaying: () => !stale() && setPhase("playing"),
          onError: (kind) => fail(kind),
        });
        if (stale()) {
          stopHls();
          return;
        }
        stopRef.current = stopHls;
      }
    } catch (error) {
      const kind = error instanceof WhepError ? error.kind : ((error as { kind?: string }).kind ?? "network");
      fail(kind, kind === "unsupported" ? fmt(t.detail.preview.errors.unsupported, { mode: modeName(mode) }) : undefined);
    }
  };

  const active = phase === "starting" || phase === "playing";
  return (
    <div className="flex flex-col gap-3">
      <div className="relative aspect-video overflow-hidden rounded-xl bg-black">
        <video ref={videoRef} muted playsInline controls={phase === "playing"} className="size-full object-contain" aria-label={t.detail.previewTitle} data-testid="preview-video" />
        {phase !== "playing" ? (
          <div className="absolute inset-0 grid place-items-center bg-[var(--surface-secondary)] p-6 text-center text-sm text-[var(--muted)]">
            {phase === "starting" ? t.detail.preview.starting : !live ? t.detail.preview.offline : t.detail.previewBody}
          </div>
        ) : null}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {active ? (
          <Button variant="secondary" onPress={() => void stop()}>
            <Square size={14} aria-hidden />
            {t.detail.preview.stop}
          </Button>
        ) : (
          <Button variant="primary" onPress={() => void start()} isDisabled={!live || unavailable}>
            <Play size={14} aria-hidden />
            {t.detail.preview.start}
          </Button>
        )}
        <div role="group" aria-label={t.detail.previewTitle} className="flex gap-1">
          {(["webrtc", "hls"] as const).map((m) => (
            <Button
              key={m}
              size="sm"
              variant={mode === m ? "secondary" : "ghost"}
              aria-pressed={mode === m}
              isDisabled={active}
              onPress={() => setMode(m)}
            >
              {modeName(m)}
            </Button>
          ))}
        </div>
        {phase === "playing" ? (
          <Chip size="sm" variant="soft" color="success">
            {fmt(t.detail.preview.playing, { mode: modeName(mode) })}
          </Chip>
        ) : null}
      </div>

      <p className="text-xs text-[var(--muted)]">
        {mode === "webrtc" ? t.detail.preview.modeWebrtcHelp : t.detail.preview.modeHlsHelp}
        {phase === "playing" ? ` ${t.detail.preview.muted}` : ""}
        {server?.demo && phase === "playing" ? ` ${t.detail.preview.demo}` : ""}
      </p>
      {unavailable && live ? <p className="text-xs text-[var(--warning)]">{fmt(t.detail.preview.disabled, { mode: modeName(mode) })}</p> : null}
      {error ? (
        <div role="alert" className="flex flex-wrap items-center gap-2 text-sm text-[var(--danger)]">
          <span>{error}</span>
          {showHlsHint ? (
            <Button
              size="sm"
              variant="tertiary"
              onPress={() => {
                setMode("hls");
                setPhase("idle");
                setError(null);
              }}
            >
              {t.detail.preview.tryHls}
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
