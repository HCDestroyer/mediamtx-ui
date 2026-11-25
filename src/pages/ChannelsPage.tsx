import { lazy, Suspense, useDeferredValue, useEffect, useMemo, useState } from "react";
import { Alert, Button, Card, EmptyState, SearchField, Skeleton, Table, Tabs, useOverlayState } from "@heroui/react";
import { ArrowDown, ArrowUp, Eye, FileText, Plus, Radio, Shuffle } from "lucide-react";
import { PathEditor } from "../components/PathEditor";
import { TranscodeWizard } from "../components/TranscodeWizard";
import { ChannelStatusChip, DynamicChip, videoSummary } from "../components/ChannelChips";
import { CopyUrlMenu } from "../components/CopyUrlMenu";
import { KpiCard } from "../components/KpiCard";
import { formatAgo, formatMbps } from "../core/format";
import { maskUrlSecrets } from "../core/mask";
import { sourceLabel } from "../core/mediamtx/labels";
import type { Channel } from "../core/mediamtx/types";
import { useChannelsFeed } from "../store/channels";
import { useServers } from "../store/servers";
import { hrefFor } from "../router";
import { fmt, t } from "../i18n/es";
import { DESKTOP_QUERY, useMediaQuery } from "../hooks/useMediaQuery";
import { usePrefs } from "../store/prefs";

const ExportDialog = lazy(() => import("../components/ExportDialog"));

type Filter = "all" | "live" | "offline";

function applyFilter(channels: Channel[], filter: Filter, query: string): Channel[] {
  const needle = query.trim().toLowerCase();
  return channels.filter(
    (c) =>
      (filter === "all" || (filter === "live" ? c.live : !c.live)) &&
      (needle === "" || c.name.toLowerCase().includes(needle)),
  );
}

/** Re-renders every second so "updated 3 s ago" stays honest. */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  return now;
}

function NoServer() {
  return (
    <EmptyState className="flex flex-col items-center gap-3 py-20 text-center">
      <Radio size={36} aria-hidden className="text-[var(--muted)]" />
      <h1 className="text-xl font-bold">{t.channels.noServerTitle}</h1>
      <p className="max-w-sm text-sm text-[var(--muted)]">{t.channels.noServerBody}</p>
      <div className="flex flex-wrap justify-center gap-2">
        <Button variant="primary" onPress={() => (window.location.hash = "#/servers")}>
          {t.servers.add}
        </Button>
        <Button variant="secondary" onPress={() => useServers.getState().addDemoServer()}>
          {t.channels.tryDemo}
        </Button>
      </div>
    </EmptyState>
  );
}

export default function ChannelsPage() {
  const { server, connection, data } = useChannelsFeed();
  const pollMs = usePrefs((s) => s.pollIntervalMs);
  const now = useNow();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const deferredQuery = useDeferredValue(query);
  const desktop = useMediaQuery(DESKTOP_QUERY);
  const editor = useOverlayState();
  const wizard = useOverlayState();
  const exporter = useOverlayState();

  const rows = useMemo(
    () => applyFilter(data.channels, filter, deferredQuery),
    [data.channels, filter, deferredQuery],
  );

  if (!server) return <NoServer />;

  const { summary, history } = data;
  const trend = (pick: (p: (typeof history)[number]) => number) => history.map(pick);
  const connecting = connection.status === "idle" || connection.status === "resolving";

  if (connection.status === "offline" || connection.status === "auth-error") {
    const offline = connection.status === "offline";
    return (
      <div className="flex flex-col gap-4">
        <h1 className="text-2xl font-bold tracking-tight">{t.channels.title}</h1>
        <Alert status={offline ? "danger" : "warning"}>
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Title>{offline ? t.channels.offlineTitle : t.channels.credentialsTitle}</Alert.Title>
            <Alert.Description>{offline ? t.channels.offlineBody : t.channels.errorAuth}</Alert.Description>
          </Alert.Content>
        </Alert>
        <div>
          <Button variant="secondary" onPress={() => (window.location.hash = "#/servers")}>
            {t.channels.openServers}
          </Button>
        </div>
      </div>
    );
  }

  const loading = connecting || (data.status === "loading" && data.channels.length === 0);

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
       <div>
        <h1 className="text-2xl font-bold tracking-tight">{t.channels.title}</h1>
        <p className="mt-1 text-sm text-[var(--muted)]">
          {loading
            ? t.channels.connecting
            : `${fmt(t.channels.liveOf, { live: summary.live, total: summary.total })} · ${fmt(t.channels.updated, { ago: formatAgo(data.updatedAt, now) })} · ${fmt(t.channels.refreshEvery, { n: pollMs / 1000 })}`}
        </p>
       </div>
       <div className="flex gap-2">
        <Button variant="ghost" onPress={exporter.open} isDisabled={connecting} className="max-lg:hidden">
          <FileText size={16} aria-hidden />
          {t.unsaved.export}
        </Button>
        <Button variant="secondary" onPress={wizard.open} isDisabled={connecting}>
          <Shuffle size={16} aria-hidden />
          {t.transcode.open}
        </Button>
        <Button variant="primary" onPress={editor.open} isDisabled={connecting} className="max-lg:hidden">
          <Plus size={16} aria-hidden />
          {t.edit.newChannel}
        </Button>
       </div>
      </div>

      {/* Primary action on mobile: floating button above the tab bar. */}
      <Button
        variant="primary"
        onPress={editor.open}
        isDisabled={connecting}
        className="fixed right-4 bottom-[calc(env(safe-area-inset-bottom,0px)+5.5rem)] z-10 rounded-2xl shadow-lg lg:hidden"
      >
        <Plus size={18} aria-hidden />
        {t.edit.newChannel}
      </Button>
      <PathEditor state={editor} target={{ kind: "new" }} />
      <TranscodeWizard state={wizard} />
      {exporter.isOpen && server ? (
        <Suspense fallback={null}>
          <ExportDialog state={exporter} serverName={server.name} />
        </Suspense>
      ) : null}

      {data.error ? (
        <Alert status={data.error === "auth" ? "warning" : "danger"}>
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Description>
              {data.error === "auth" ? t.channels.errorAuth : t.channels.errorUnreachable}
            </Alert.Description>
          </Alert.Content>
        </Alert>
      ) : null}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4 lg:gap-4">
        <KpiCard
          icon={<Radio size={15} aria-hidden />} label={t.channels.kpiLive}
          value={String(summary.live)} unit={`/ ${summary.total}`} trend={trend((p) => p.live)}
        />
        <KpiCard
          icon={<Eye size={15} aria-hidden />} label={t.channels.kpiReaders}
          value={String(summary.readers)} trend={trend((p) => p.readers)}
        />
        <KpiCard
          icon={<ArrowDown size={15} aria-hidden />} label={t.channels.kpiIn}
          value={history.length ? formatMbps(summary.inMbps) : "—"} unit={t.channels.mbps} trend={trend((p) => p.inMbps)}
        />
        <KpiCard
          icon={<ArrowUp size={15} aria-hidden />} label={t.channels.kpiOut}
          value={history.length ? formatMbps(summary.outMbps) : "—"} unit={t.channels.mbps}
          trend={trend((p) => p.outMbps)} trendColor="var(--success)"
        />
      </div>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <SearchField value={query} onChange={setQuery} aria-label={t.channels.search} className="sm:w-72">
          <SearchField.Group>
            <SearchField.SearchIcon />
            <SearchField.Input placeholder={t.channels.search} />
            <SearchField.ClearButton />
          </SearchField.Group>
        </SearchField>
        <Tabs selectedKey={filter} onSelectionChange={(key) => setFilter(String(key) as Filter)}>
          <Tabs.ListContainer>
            <Tabs.List aria-label={t.channels.title}>
              <Tabs.Tab id="all" className="whitespace-nowrap">{t.channels.filterAll} {data.channels.length}<Tabs.Indicator /></Tabs.Tab>
              <Tabs.Tab id="live" className="whitespace-nowrap">{t.channels.filterLive} {summary.live}<Tabs.Indicator /></Tabs.Tab>
              <Tabs.Tab id="offline" className="whitespace-nowrap">{t.channels.filterOffline} {summary.total - summary.live}<Tabs.Indicator /></Tabs.Tab>
            </Tabs.List>
          </Tabs.ListContainer>
        </Tabs>
      </div>

      {loading ? (
        <div className="flex flex-col gap-2" aria-busy>
          {[0, 1, 2].map((i) => <Skeleton key={i} className="h-16 w-full rounded-xl" />)}
        </div>
      ) : rows.length === 0 ? (
        <EmptyState className="flex flex-col items-center gap-1 py-14 text-center">
          <p className="font-semibold">
            {data.channels.length === 0 ? t.channels.emptyTitle : t.channels.noResultsTitle}
          </p>
          <p className="text-sm text-[var(--muted)]">
            {data.channels.length === 0 ? t.channels.emptyBody : t.channels.noResultsBody}
          </p>
        </EmptyState>
      ) : (
        desktop ? (
          <ChannelTable rows={rows} rates={data.rates} />
        ) : (
          <div className="flex flex-col gap-2.5">
            {rows.map((channel) => (
              <ChannelCard key={channel.name} channel={channel} rate={data.rates[channel.name] ?? null} />
            ))}
          </div>
        )
      )}
    </div>
  );
}

type Rates = ReturnType<typeof useChannelsFeed>["data"]["rates"];

function ChannelName({ channel }: { channel: Channel }) {
  return (
    <div className="flex min-w-0 flex-col">
      <span className="flex items-center gap-2">
        <span className="truncate font-semibold">{channel.name}</span>
        <DynamicChip kind={channel.kind} />
      </span>
      <span className="truncate text-xs text-[var(--muted)]">{channel.source ? (channel.source.id.includes("://") ? maskUrlSecrets(channel.source.id) : sourceLabel(channel.source.type)) : "—"}</span>
    </div>
  );
}

function ChannelTable({ rows, rates }: { rows: Channel[]; rates: Rates }) {
  return (
    <Table>
      <Table.ScrollContainer>
        <Table.Content
          aria-label={t.channels.title}
          onRowAction={(key) => (window.location.hash = hrefFor({ name: "channel", channel: String(key) }))}
        >
          <Table.Header>
            <Table.Column isRowHeader id="name">{t.channels.colChannel}</Table.Column>
            <Table.Column id="status">{t.channels.colStatus}</Table.Column>
            <Table.Column id="video">{t.channels.colVideo}</Table.Column>
            <Table.Column id="readers" className="text-end">{t.channels.colReaders}</Table.Column>
            <Table.Column id="in" className="text-end">{t.channels.colIn}</Table.Column>
            <Table.Column id="out" className="text-end">{t.channels.colOut}</Table.Column>
            <Table.Column id="actions" className="w-12"><span className="sr-only">{t.detail.copyUrl}</span></Table.Column>
          </Table.Header>
          <Table.Body items={rows}>
            {(channel) => {
              const rate = rates[channel.name] ?? null;
              return (
                <Table.Row id={channel.name}>
                  <Table.Cell><ChannelName channel={channel} /></Table.Cell>
                  <Table.Cell><ChannelStatusChip live={channel.live} /></Table.Cell>
                  <Table.Cell>{videoSummary(channel)}</Table.Cell>
                  <Table.Cell className="tabular text-end">{channel.live ? channel.readerCount : "—"}</Table.Cell>
                  <Table.Cell className="tabular text-end">{channel.live ? formatMbps(rate?.inMbps) : "—"}</Table.Cell>
                  <Table.Cell className="tabular text-end">{channel.live ? formatMbps(rate?.outMbps) : "—"}</Table.Cell>
                  <Table.Cell><CopyUrlMenu channel={channel.name} variant="ghost" size="sm" iconOnly /></Table.Cell>
                </Table.Row>
              );
            }}
          </Table.Body>
        </Table.Content>
      </Table.ScrollContainer>
    </Table>
  );
}

function ChannelCard({ channel, rate }: { channel: Channel; rate: { inMbps: number; outMbps: number } | null }) {
  return (
    <Card className="relative">
      <Card.Content className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-2">
          <a
            href={hrefFor({ name: "channel", channel: channel.name })}
            className="flex min-w-0 items-center gap-2 outline-none after:absolute after:inset-0 focus-visible:underline"
          >
            <span className="truncate font-semibold">{channel.name}</span>
            <DynamicChip kind={channel.kind} />
          </a>
          <ChannelStatusChip live={channel.live} />
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-[var(--muted)]">
          {channel.live ? (
            <>
              <span>{videoSummary(channel)}</span>
              <span className="inline-flex items-center gap-1"><Eye size={12} aria-hidden />{channel.readerCount}</span>
              <span className="tabular inline-flex items-center gap-1"><ArrowDown size={12} aria-hidden />{formatMbps(rate?.inMbps)}</span>
              <span className="tabular inline-flex items-center gap-1"><ArrowUp size={12} aria-hidden />{formatMbps(rate?.outMbps)}</span>
            </>
          ) : (
            <span>{t.channels.statusOffline}</span>
          )}
        </div>
      </Card.Content>
    </Card>
  );
}
