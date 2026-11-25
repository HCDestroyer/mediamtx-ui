import { Chip } from "@heroui/react";
import type { Channel } from "../core/mediamtx/types";
import { t } from "../i18n/es";

export function ChannelStatusChip({ live }: Pick<Channel, "live">) {
  return live ? (
    <Chip size="sm" color="success" variant="soft">
      <span className="size-1.5 rounded-full bg-current" aria-hidden />
      {t.channels.statusLive}
    </Chip>
  ) : (
    <Chip size="sm" variant="soft">
      <span className="size-1.5 rounded-full bg-current" aria-hidden />
      {t.channels.statusOffline}
    </Chip>
  );
}

export function DynamicChip({ kind }: Pick<Channel, "kind">) {
  return kind === "dynamic" ? (
    <Chip size="sm" color="accent" variant="soft">
      {t.channels.dynamic}
    </Chip>
  ) : null;
}

/** "H264 1080p" style summary of the video track, or an em dash. */
export function videoSummary(channel: Channel): string {
  const video = channel.tracks.find((track) => track.kind === "video");
  if (!video) return "—";
  const height = /×(\d+)/.exec(video.detail)?.[1];
  return height ? `${video.codec} ${height}p` : video.codec;
}
