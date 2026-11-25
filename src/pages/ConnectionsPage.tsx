import { useEffect, useMemo, useRef, useState } from "react";
import { AlertDialog, Alert, Button, Chip, EmptyState, ListBox, SearchField, Select, Spinner, toast, useOverlayState } from "@heroui/react";
import { Link2, UserX } from "lucide-react";
import { ApiError } from "../core/mediamtx/api";
import { BitrateTracker, type Rate } from "../core/mediamtx/bitrate";
import { kickConnection, listConnections, PROTOCOLS, type Connection, type Proto } from "../core/mediamtx/connections";
import { formatMbps, formatSince } from "../core/format";
import { apiErrorMessage, usePathApi } from "../hooks/usePathApi";
import { fmt, t } from "../i18n/es";
import { usePrefs } from "../store/prefs";
import { useServers, selectActiveServer } from "../store/servers";

const PROTO_COLOR: Record<Proto, "accent" | "success" | "warning" | "default"> = {
  rtsp: "accent", rtsps: "accent", rtmp: "warning", rtmps: "warning", srt: "success", webrtc: "default", hls: "default",
};
const GRID = "lg:grid lg:grid-cols-[5rem_minmax(0,1.2fr)_5.5rem_minmax(0,1fr)_5rem_5.5rem_5.5rem_7rem] lg:items-center lg:gap-3";

const label = (proto: Proto) => t.connections.protocols[proto];

export default function ConnectionsPage() {
  const server = useServers(selectActiveServer);
  const api = usePathApi();
  const pollMs = usePrefs((s) => s.pollIntervalMs);
  const [list, setList] = useState<Connection[] | null>(null);
  const [rates, setRates] = useState<Map<string, Rate | null>>(new Map());
  const [unavailable, setUnavailable] = useState<Proto[]>([]);
  const [problem, setProblem] = useState<"unauthorized" | "unreachable" | null>(null);
  const [query, setQuery] = useState("");
  const [proto, setProto] = useState<"all" | Proto>("all");
  const [now, setNow] = useState(() => Date.now());
  const [kicking, setKicking] = useState<Connection | null>(null);
  const confirm = useOverlayState();
  const tracker = useRef(new BitrateTracker());
  const client = api.client;

  useEffect(() => {
    if (!client) return;
    let alive = true;
    tracker.current.reset();
    setList(null);
    const load = async () => {
      try {
        const result = await listConnections(client);
        if (!alive) return;
        const at = Date.now();
        const samples = new Map(result.connections.map((c) => [c.key, { bytesIn: c.inBytes, bytesOut: c.outBytes }]));
        setRates(tracker.current.update(samples, at));
        setList(result.connections);
        setUnavailable(result.unavailable);
        setProblem(null);
        setNow(at);
      } catch (error) {
        if (!alive) return;
        setProblem(error instanceof ApiError && (error.status === 401 || error.status === 403) ? "unauthorized" : "unreachable");
      }
    };
    void load();
    const id = setInterval(() => void load(), pollMs);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [client, pollMs]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (list ?? [])
      .filter((c) => proto === "all" || c.proto === proto)
      .filter((c) => !q || [c.path, c.remoteAddr, c.user].some((v) => v.toLowerCase().includes(q)))
      .sort((a, b) => a.path.localeCompare(b.path) || a.proto.localeCompare(b.proto) || a.id.localeCompare(b.id));
  }, [list, query, proto]);

  const frame = (children: React.ReactNode) => (
    <div className="flex flex-col gap-5">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">{t.connections.title}</h1>
        <p className="text-sm text-[var(--muted)]">{t.connections.subtitle}</p>
      </div>
      {children}
    </div>
  );

  if (!server) {
    return frame(<EmptyState className="py-16 text-center text-sm text-[var(--muted)]">{t.connections.noServer}</EmptyState>);
  }
  if (!client || (list === null && !problem)) {
    return frame(
      <div className="grid place-items-center py-16" role="status" aria-label={t.connections.connecting}>
        <Spinner />
      </div>,
    );
  }

  const publishers = (list ?? []).filter((c) => c.role === "publisher").length;
  const counts = new Map<Proto, number>();
  for (const c of list ?? []) counts.set(c.proto, (counts.get(c.proto) ?? 0) + 1);

  const doKick = async (conn: Connection) => {
    try {
      await kickConnection(client, conn);
      toast.success(t.connections.kicked);
      setList((current) => current?.filter((c) => c.key !== conn.key) ?? null);
    } catch (error) {
      toast.danger(t.connections.kickFailed, { description: apiErrorMessage(error, "") || undefined });
    }
  };

  return frame(
    <>
      {problem ? (
        <Alert status="warning">
          <Alert.Content>
            <Alert.Description>{problem === "unauthorized" ? t.connections.unauthorized : t.connections.unreachable}</Alert.Description>
          </Alert.Content>
        </Alert>
      ) : null}

      <div className="flex flex-wrap items-center gap-3">
        <p className="text-sm text-[var(--muted)]" data-testid="summary">
          {fmt(t.connections.summary, { n: list?.length ?? 0, pub: publishers, read: (list?.length ?? 0) - publishers })}
        </p>
        <div className="flex flex-wrap gap-1.5">
          {[...counts].map(([p, n]) => (
            <Chip key={p} size="sm" variant="soft" color={PROTO_COLOR[p]}>
              {label(p)} {n}
            </Chip>
          ))}
        </div>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <SearchField value={query} onChange={setQuery} aria-label={t.connections.search} className="min-w-56 flex-1">
          <SearchField.Group>
            <SearchField.SearchIcon />
            <SearchField.Input placeholder={t.connections.search} />
            <SearchField.ClearButton />
          </SearchField.Group>
        </SearchField>
        <Select selectedKey={proto} onSelectionChange={(key) => setProto(String(key) as "all" | Proto)} aria-label={t.connections.colProtocol} className="w-40">
          <Select.Trigger>
            <Select.Value />
            <Select.Indicator />
          </Select.Trigger>
          <Select.Popover>
            <ListBox>
              <ListBox.Item id="all" textValue={t.connections.allProtocols}>
                {t.connections.allProtocols}
              </ListBox.Item>
              {PROTOCOLS.map((p) => (
                <ListBox.Item key={p.proto} id={p.proto} textValue={label(p.proto)}>
                  {label(p.proto)}
                </ListBox.Item>
              ))}
            </ListBox>
          </Select.Popover>
        </Select>
      </div>

      {unavailable.length > 0 && unavailable.length < PROTOCOLS.length ? (
        <p className="text-xs text-[var(--muted)]">{fmt(t.connections.unavailable, { list: unavailable.map(label).join(", ") })}</p>
      ) : null}

      {shown.length === 0 ? (
        <EmptyState className="flex flex-col items-center gap-2 py-14 text-center">
          <Link2 size={32} aria-hidden className="text-[var(--muted)]" />
          <p className="font-semibold">{(list?.length ?? 0) === 0 ? t.connections.emptyTitle : t.connections.noMatch}</p>
          {(list?.length ?? 0) === 0 ? <p className="max-w-sm text-sm text-[var(--muted)]">{t.connections.emptyBody}</p> : null}
        </EmptyState>
      ) : (
        <div role="table" aria-label={t.connections.title} className="flex flex-col gap-2 lg:gap-0">
          <div role="row" className={`${GRID} hidden border-b border-[var(--border)] pb-2 text-xs font-medium text-[var(--muted)]`}>
            <span role="columnheader">{t.connections.colProtocol}</span>
            <span role="columnheader">{t.connections.colChannel}</span>
            <span role="columnheader">{t.connections.colRole}</span>
            <span role="columnheader">{t.connections.colClient}</span>
            <span role="columnheader">{t.connections.colTime}</span>
            <span role="columnheader" className="text-right">{t.connections.colIn}</span>
            <span role="columnheader" className="text-right">{t.connections.colOut}</span>
            <span role="columnheader" />
          </div>
          {shown.map((c) => {
            const rate = rates.get(c.key) ?? null;
            return (
              <div
                key={c.key}
                role="row"
                data-testid={`conn-${c.key}`}
                className={`${GRID} flex flex-col gap-1.5 rounded-xl bg-[var(--surface)] p-3 text-sm lg:rounded-none lg:border-b lg:border-[var(--border)] lg:bg-transparent lg:px-0 lg:py-2.5`}
              >
                <span role="cell" className="flex items-center gap-2">
                  <Chip size="sm" variant="soft" color={PROTO_COLOR[c.proto]}>
                    {label(c.proto)}
                  </Chip>
                  <span className="font-medium lg:hidden">{c.path || t.connections.noPath}</span>
                </span>
                <span role="cell" className="hidden min-w-0 truncate font-medium lg:block">
                  {c.path || <span className="text-[var(--muted)]">{t.connections.noPath}</span>}
                </span>
                <span role="cell">
                  <Chip size="sm" variant="soft" color={c.role === "publisher" ? "warning" : "default"}>
                    {c.role === "publisher" ? t.connections.publisher : t.connections.reader}
                  </Chip>
                </span>
                <span role="cell" className="min-w-0 truncate font-mono text-xs text-[var(--muted)]" title={c.remoteAddr}>
                  {c.remoteAddr}
                  {c.user ? ` · ${c.user}` : ""}
                  {c.transport ? ` · ${c.transport}` : ""}
                  {c.rttMs !== undefined ? ` · ${fmt(t.connections.quality, { rtt: Math.round(c.rttMs), loss: (c.lossPct ?? 0).toFixed(1) })}` : ""}
                </span>
                <span role="cell" className="text-xs text-[var(--muted)]">
                  {formatSince(c.created ? new Date(c.created).toISOString() : null, now)}
                </span>
                <span role="cell" className="tabular-nums lg:text-right">
                  <span className="text-xs text-[var(--muted)] lg:hidden">{t.connections.colIn}: </span>
                  {formatMbps(rate?.inMbps)}
                </span>
                <span role="cell" className="tabular-nums lg:text-right">
                  <span className="text-xs text-[var(--muted)] lg:hidden">{t.connections.colOut}: </span>
                  {formatMbps(rate?.outMbps)}
                </span>
                <span role="cell" className="flex lg:justify-end">
                  <Button
                    size="sm"
                    variant="danger-soft"
                    onPress={() => {
                      setKicking(c);
                      confirm.open();
                    }}
                  >
                    <UserX size={14} aria-hidden />
                    {t.connections.kick}
                  </Button>
                </span>
              </div>
            );
          })}
        </div>
      )}

      <AlertDialog isOpen={confirm.isOpen} onOpenChange={confirm.setOpen}>
        <AlertDialog.Backdrop>
          <AlertDialog.Container>
            <AlertDialog.Dialog>
              <AlertDialog.Header>
                <AlertDialog.Heading>{t.connections.kickTitle}</AlertDialog.Heading>
              </AlertDialog.Header>
              <AlertDialog.Body className="flex flex-col gap-2">
                <p>{fmt(t.connections.kickBody, { proto: kicking ? label(kicking.proto) : "", addr: kicking?.remoteAddr ?? "" })}</p>
                {kicking?.role === "publisher" ? <p className="text-[var(--warning)]">{fmt(t.connections.kickPublisher, { path: kicking.path })}</p> : null}
              </AlertDialog.Body>
              <AlertDialog.Footer>
                <Button variant="tertiary" onPress={confirm.close}>
                  {t.connections.cancel}
                </Button>
                <Button
                  variant="danger"
                  onPress={() => {
                    const target = kicking;
                    confirm.close();
                    if (target) void doKick(target);
                  }}
                >
                  {t.connections.kickConfirm}
                </Button>
              </AlertDialog.Footer>
            </AlertDialog.Dialog>
          </AlertDialog.Container>
        </AlertDialog.Backdrop>
      </AlertDialog>
    </>,
  );
}
