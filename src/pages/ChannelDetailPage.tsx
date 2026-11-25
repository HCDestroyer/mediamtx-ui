import { Card, Chip, EmptyState, Skeleton } from "@heroui/react";
import { ArrowDown, ArrowLeft, ArrowUp, Film, Volume2 } from "lucide-react";
import type { ReactNode } from "react";
import { ChannelStatusChip, DynamicChip } from "../components/ChannelChips";
import { CopyUrlMenu } from "../components/CopyUrlMenu";
import { formatBytes, formatMbps, formatSince } from "../core/format";
import { readerLabel, sourceLabel } from "../core/mediamtx/labels";
import type { Track } from "../core/mediamtx/types";
import { t } from "../i18n/es";
import { useChannelsFeed } from "../store/channels";

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1.5 text-sm">
      <dt className="shrink-0 text-[var(--muted)]">{label}</dt>
      <dd className="min-w-0 text-end [overflow-wrap:anywhere]">{children}</dd>
    </div>
  );
}

const TRACK_ICON = { video: Film, audio: Volume2, other: Film } as const;
const TRACK_LABEL = { video: t.detail.trackVideo, audio: t.detail.trackAudio, other: t.detail.trackOther } as const;

function TrackRow({ track }: { track: Track }) {
  const Icon = TRACK_ICON[track.kind];
  return (
    <li className="flex items-center gap-3 border-b border-[var(--border)] py-2.5 last:border-0">
      <Icon size={16} aria-hidden className="shrink-0 text-[var(--muted)]" />
      <span className="w-14 shrink-0 text-sm text-[var(--muted)]">{TRACK_LABEL[track.kind]}</span>
      <Chip size="sm" color="accent" variant="soft">{track.codec}</Chip>
      <span className="tabular min-w-0 text-sm [overflow-wrap:anywhere]">{track.detail}</span>
    </li>
  );
}

export default function ChannelDetailPage({ name }: { name: string }) {
  const { server, data } = useChannelsFeed();
  const channel = data.channels.find((c) => c.name === name);
  const rate = data.rates[name] ?? null;
  const now = Date.now();

  const back = (
    <a
      href="#/"
      className="inline-flex items-center gap-1 text-sm text-[var(--muted)] outline-none hover:text-[var(--foreground)] focus-visible:underline"
    >
      <ArrowLeft size={14} aria-hidden />
      {t.detail.back}
    </a>
  );

  if (!channel) {
    const waiting = !server || data.status === "loading";
    return (
      <div className="flex flex-col gap-4">
        {back}
        {waiting ? (
          <Skeleton className="h-24 w-full rounded-xl" />
        ) : (
          <EmptyState className="flex flex-col items-center gap-1 py-16 text-center">
            <h1 className="text-lg font-bold">{t.detail.notFoundTitle}</h1>
            <p className="text-sm text-[var(--muted)]">{t.detail.notFoundBody}</p>
          </EmptyState>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      {back}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-bold tracking-tight [overflow-wrap:anywhere]">{channel.name}</h1>
            <ChannelStatusChip live={channel.live} />
            <DynamicChip kind={channel.kind} />
          </div>
          <p className="mt-1 text-sm text-[var(--muted)]">
            {channel.source
              ? `${sourceLabel(channel.source.type)}${channel.source.id ? ` · ${channel.source.id}` : ""}`
              : t.detail.noOrigin}
          </p>
        </div>
        <CopyUrlMenu channel={channel.name} />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <div className="flex min-w-0 flex-col gap-4">
          <Card>
            <Card.Header><Card.Title>{t.detail.previewTitle}</Card.Title></Card.Header>
            <Card.Content>
              <div className="grid aspect-video place-items-center rounded-xl bg-[var(--surface-secondary)] p-6 text-center text-sm text-[var(--muted)]">
                {t.detail.previewBody}
              </div>
            </Card.Content>
          </Card>

          <Card>
            <Card.Header><Card.Title>{t.detail.tracks}</Card.Title></Card.Header>
            <Card.Content>
              {channel.tracks.length === 0 ? (
                <p className="text-sm text-[var(--muted)]">{t.detail.noTracks}</p>
              ) : (
                <ul>{channel.tracks.map((track, i) => <TrackRow key={`${track.codec}-${i}`} track={track} />)}</ul>
              )}
            </Card.Content>
          </Card>
        </div>

        <div className="flex min-w-0 flex-col gap-4">
          <Card>
            <Card.Header><Card.Title>{t.detail.status}</Card.Title></Card.Header>
            <Card.Content>
              <dl className="divide-y divide-[var(--border)]">
                <Row label={t.detail.kind}>{channel.kind === "dynamic" ? t.detail.kindDynamic : t.detail.kindConfigured}</Row>
                {channel.live ? (
                  <>
                    <Row label={t.detail.liveFor}>{formatSince(channel.liveSince, now)}</Row>
                    <Row label={t.detail.rateIn}>
                      <span className="tabular inline-flex items-center gap-1"><ArrowDown size={12} aria-hidden />{formatMbps(rate?.inMbps)} Mbps</span>
                    </Row>
                    <Row label={t.detail.rateOut}>
                      <span className="tabular inline-flex items-center gap-1"><ArrowUp size={12} aria-hidden />{formatMbps(rate?.outMbps)} Mbps</span>
                    </Row>
                    <Row label={t.detail.received}><span className="tabular">{formatBytes(channel.bytesIn)}</span></Row>
                    <Row label={t.detail.sent}><span className="tabular">{formatBytes(channel.bytesOut)}</span></Row>
                  </>
                ) : null}
              </dl>
              {channel.kind === "dynamic" ? (
                <p className="mt-3 text-xs text-[var(--muted)]">{t.detail.dynamicNote}</p>
              ) : null}
            </Card.Content>
          </Card>

          <Card>
            <Card.Header className="flex flex-row items-center justify-between">
              <Card.Title>{t.detail.readers}</Card.Title>
              <Chip size="sm" variant="soft">{channel.readerCount}</Chip>
            </Card.Header>
            <Card.Content>
              {channel.readers.length === 0 ? (
                <p className="text-sm text-[var(--muted)]">{t.detail.noReaders}</p>
              ) : (
                <ul>
                  {channel.readers.map((reader, i) => (
                    <li key={`${reader.id}-${i}`} className="flex items-center gap-2 border-b border-[var(--border)] py-2 last:border-0">
                      <Chip size="sm" color="accent" variant="soft">{readerLabel(reader.type)}</Chip>
                      <code className="min-w-0 truncate text-xs text-[var(--muted)]">{reader.id}</code>
                    </li>
                  ))}
                </ul>
              )}
            </Card.Content>
          </Card>
        </div>
      </div>
    </div>
  );
}
