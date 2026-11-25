import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertDialog, Alert, Button, Card, Chip, EmptyState, Spinner, toast, useOverlayState } from "@heroui/react";
import { ArrowRight, Pencil, Play, Plus, Square, Trash2, Waypoints } from "lucide-react";
import { AgentError, createAgentClient, MIXED_CONTENT, type AgentClient } from "../core/agent/api";
import { DEMO_AGENT_TOKEN, DEMO_AGENT_URL } from "../core/agent/demo";
import type { AgentMapEntry, AgentView, MapState } from "../core/agent/types";
import { agentTransportFor } from "../core/transport";
import type { AgentConfig, Server } from "../core/types";
import { ServiceEditor } from "../components/ServiceEditor";
import { fmt, t } from "../i18n/es";
import { hrefFor } from "../router";
import { usePrefs } from "../store/prefs";
import { selectActiveServer, useServers } from "../store/servers";

type Problem = "unreachable" | "mixed" | "unauthorized" | "limited" | null;

/** Demo servers always use the built-in simulated agent. */
function agentOf(server: Server): AgentConfig | undefined {
  return server.demo ? { url: DEMO_AGENT_URL, token: DEMO_AGENT_TOKEN } : server.agent;
}

function problemOf(error: unknown): Problem {
  if (!(error instanceof AgentError)) return "unreachable";
  if (error.status === 401 || error.status === 403) return "unauthorized";
  if (error.status === 429) return "limited";
  if (error.status === MIXED_CONTENT) return "mixed";
  return "unreachable";
}

function failureText(error: unknown): string | undefined {
  return error instanceof AgentError ? (error.detail ?? undefined) : undefined;
}

function duration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return h > 0 ? `${h} h ${m} min` : m > 0 ? `${m} min` : `${seconds} s`;
}

const STATE_COLOR: Record<MapState, "success" | "warning" | "danger"> = { ok: "success", fallback: "warning", missing: "danger" };
const STATE_LABEL: Record<MapState, string> = { ok: t.services.stateOk, fallback: t.services.stateFallback, missing: t.services.stateMissing };
const KIND_LABEL: Record<string, string> = { video: t.services.video, audio: t.services.audio, subtitle: t.services.subtitles, data: t.services.data };

export default function ServicesPage() {
  const server = useServers(selectActiveServer);
  if (!server) {
    return (
      <Shell>
        <EmptyState className="py-16 text-center text-sm text-[var(--muted)]">{t.services.noServer}</EmptyState>
      </Shell>
    );
  }
  const agent = agentOf(server);
  if (!agent) {
    return (
      <Shell>
        <EmptyState className="flex flex-col items-center gap-2 py-16 text-center">
          <Waypoints size={32} aria-hidden className="text-[var(--muted)]" />
          <p className="font-semibold">{t.services.noAgentTitle}</p>
          <p className="max-w-sm text-sm text-[var(--muted)]">{t.services.noAgentBody}</p>
          <a href={hrefFor({ name: "servers" })} className="text-sm font-medium text-[var(--accent)] underline">
            {t.services.noAgentAction}
          </a>
        </EmptyState>
      </Shell>
    );
  }
  return <ServicesList key={`${server.id}:${agent.url}:${agent.token}:${agent.username ?? ""}:${agent.password ?? ""}`} server={server} agent={agent} />;
}

function Shell({ children, action }: { children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <h1 className="text-2xl font-bold tracking-tight">{t.services.title}</h1>
          <p className="text-sm text-[var(--muted)]">{t.services.subtitle}</p>
        </div>
        {action}
      </div>
      {children}
    </div>
  );
}

function ServicesList({ server, agent }: { server: Server; agent: AgentConfig }) {
  const pollIntervalMs = usePrefs((s) => s.pollIntervalMs);
  const client = useMemo<AgentClient>(
    () =>
      createAgentClient({
        baseUrl: agent.url,
        ...(agent.username
          ? { credentials: { username: agent.username, password: agent.password ?? "" } }
          : { token: agent.token }),
        transport: agentTransportFor(server),
      }),
    [agent.url, agent.token, agent.username, agent.password, server],
  );
  const [views, setViews] = useState<AgentView[] | null>(null);
  const [problem, setProblem] = useState<Problem>(null);
  const [editing, setEditing] = useState<AgentView | null>(null);
  const [deleting, setDeleting] = useState<AgentView | null>(null);
  const editor = useOverlayState();
  const confirm = useOverlayState();
  const alive = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const list = await client.list();
      if (!alive.current) return;
      setViews(list);
      setProblem(null);
    } catch (error) {
      if (alive.current) setProblem(problemOf(error));
    }
  }, [client]);

  useEffect(() => {
    alive.current = true;
    void refresh();
    const id = setInterval(() => void refresh(), pollIntervalMs);
    return () => {
      alive.current = false;
      clearInterval(id);
    };
  }, [refresh, pollIntervalMs]);

  const act = async (work: () => Promise<unknown>, success?: string) => {
    try {
      await work();
      if (success) toast.success(success);
      await refresh();
    } catch (error) {
      toast.danger(t.services.failed, { description: failureText(error) });
    }
  };

  const openEditor = (view: AgentView | null) => {
    setEditing(view);
    editor.open();
  };

  return (
    <Shell
      action={
        <Button variant="primary" onPress={() => openEditor(null)} isDisabled={views === null}>
          <Plus size={16} aria-hidden />
          {t.services.add}
        </Button>
      }
    >
      {problem ? (
        <Alert status="warning">
          <Alert.Content>
            <Alert.Description>{problem === "mixed" ? t.services.mixed : problem === "unauthorized" ? t.services.unauthorized : problem === "limited" ? t.services.limited : t.services.unreachable}</Alert.Description>
          </Alert.Content>
        </Alert>
      ) : null}

      {views === null ? (
        problem ? null : (
          <div className="grid place-items-center py-16">
            <Spinner />
          </div>
        )
      ) : views.length === 0 ? (
        <EmptyState className="flex flex-col items-center gap-2 py-16 text-center">
          <Waypoints size={32} aria-hidden className="text-[var(--muted)]" />
          <p className="font-semibold">{t.services.emptyTitle}</p>
          <p className="max-w-sm text-sm text-[var(--muted)]">{t.services.emptyBody}</p>
        </EmptyState>
      ) : (
        <div className="grid gap-4 xl:grid-cols-2">
          {views.map((view) => (
            <ServiceCard
              key={view.service.id}
              view={view}
              onToggle={() => void act(() => client.setEnabled(view.service.id, view.status.state !== "running"))}
              onSwitch={(input) => void act(() => client.switchInput(view.service.id, input), t.services.switched)}
              onEdit={() => openEditor(view)}
              onDelete={() => {
                setDeleting(view);
                confirm.open();
              }}
            />
          ))}
        </div>
      )}

      <ServiceEditor
        state={editor}
        service={editing?.service}
        onSave={async (service) => {
          if (editing) await client.update({ ...service, id: editing.service.id });
          else await client.create(service);
          toast.success(t.services.saved);
          await refresh();
        }}
      />

      <AlertDialog isOpen={confirm.isOpen} onOpenChange={confirm.setOpen}>
        <AlertDialog.Backdrop>
          <AlertDialog.Container>
            <AlertDialog.Dialog>
              <AlertDialog.Header>
                <AlertDialog.Heading>{t.services.deleteTitle}</AlertDialog.Heading>
              </AlertDialog.Header>
              <AlertDialog.Body>
                <p>{fmt(t.services.deleteBody, { name: deleting?.service.name ?? "" })}</p>
              </AlertDialog.Body>
              <AlertDialog.Footer>
                <Button variant="tertiary" onPress={confirm.close}>
                  {t.services.cancel}
                </Button>
                <Button
                  variant="danger"
                  onPress={() => {
                    const target = deleting;
                    confirm.close();
                    if (target) void act(() => client.remove(target.service.id), t.services.deleted);
                  }}
                >
                  {t.services.confirmDelete}
                </Button>
              </AlertDialog.Footer>
            </AlertDialog.Dialog>
          </AlertDialog.Container>
        </AlertDialog.Backdrop>
      </AlertDialog>
    </Shell>
  );
}

interface ServiceCardProps {
  view: AgentView;
  onToggle: () => void;
  onSwitch: (input: number) => void;
  onEdit: () => void;
  onDelete: () => void;
}

function ServiceCard({ view, onToggle, onSwitch, onEdit, onDelete }: ServiceCardProps) {
  const { service, status } = view;
  const running = status.state === "running";
  return (
    <Card data-testid={`service-${service.id}`}>
      <Card.Header className="flex flex-row items-center gap-2">
        <Card.Title className="min-w-0 flex-1 truncate">{service.name}</Card.Title>
        <Chip size="sm" color={running ? "success" : "default"} variant="soft">
          {running ? t.services.running : t.services.stopped}
        </Chip>
      </Card.Header>
      <Card.Content className="flex flex-col gap-4">
        {running ? (
          <p className="text-xs text-[var(--muted)]">
            {fmt(t.services.uptime, { time: duration(status.uptimeSec) })} · {fmt(t.services.outKbps, { n: Math.round(status.outKbps) })}
          </p>
        ) : null}

        <Section title={t.services.inputs}>
          {status.inputs.map((input) => {
            const active = running && input.active;
            return (
              <div key={input.index} className="flex flex-wrap items-center gap-2 rounded-lg bg-[var(--surface-secondary)] px-3 py-2 text-sm">
                <span className="min-w-0 flex-1 truncate font-mono text-xs" title={input.url}>
                  {input.index + 1}. {input.url}
                </span>
                <Chip size="sm" variant="soft" color={active ? "success" : input.up ? "default" : "danger"}>
                  {active ? t.services.active : input.up ? t.services.standby : t.services.down}
                </Chip>
                {running && input.up ? <span className="text-xs text-[var(--muted)]">{Math.round(input.kbps)} kb/s</span> : null}
                {input.ccErrors > 0 ? <span className="text-xs text-[var(--warning)]">{fmt(t.services.ccErrors, { n: input.ccErrors })}</span> : null}
                {running && !active ? (
                  <Button size="sm" variant="tertiary" onPress={() => onSwitch(input.index)}>
                    {t.services.useInput}
                  </Button>
                ) : null}
              </div>
            );
          })}
        </Section>

        <Section title={t.services.mapping}>
          <div className="flex flex-col gap-1">
            {status.mapping.map((entry) => (
              <MapRow key={entry.outPid} entry={entry} />
            ))}
          </div>
        </Section>

        <Section title={t.services.outputs}>
          {status.outputs.map((output) => (
            <div key={output.index} className="flex items-center gap-2 text-xs">
              <span className={`size-2 rounded-full ${running && output.up ? "bg-[var(--success)]" : "bg-[var(--muted)]"}`} aria-hidden />
              <span className="min-w-0 flex-1 truncate font-mono" title={output.url}>
                {output.url}
              </span>
            </div>
          ))}
        </Section>

        <Section title={t.services.events}>
          {status.events.length === 0 ? (
            <p className="text-xs text-[var(--muted)]">{t.services.noEvents}</p>
          ) : (
            <ul className="flex flex-col gap-0.5 text-xs text-[var(--muted)]">
              {status.events.slice(0, 3).map((event, i) => (
                <li key={`${event.at}${i}`}>
                  <time dateTime={event.at}>{new Date(event.at).toLocaleTimeString()}</time> · {event.message}
                </li>
              ))}
            </ul>
          )}
        </Section>

        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant={running ? "secondary" : "primary"} onPress={onToggle}>
            {running ? <Square size={14} aria-hidden /> : <Play size={14} aria-hidden />}
            {running ? t.services.stop : t.services.start}
          </Button>
          <div className="ml-auto flex items-center gap-1">
            <Button size="sm" variant="ghost" onPress={onEdit}>
              <Pencil size={14} aria-hidden />
              {t.services.edit}
            </Button>
            <Button size="sm" variant="danger-soft" isIconOnly aria-label={t.services.delete} onPress={onDelete}>
              <Trash2 size={14} aria-hidden />
            </Button>
          </div>
        </div>
      </Card.Content>
    </Card>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-1.5">
      <h3 className="text-[11px] font-semibold uppercase tracking-wider text-[var(--muted)]">{title}</h3>
      {children}
    </section>
  );
}

function MapRow({ entry }: { entry: AgentMapEntry }) {
  const label = `${KIND_LABEL[entry.kind] ?? entry.kind}${entry.lang ? ` ${entry.lang}` : ""}`;
  return (
    <div className="flex items-center gap-2 text-sm">
      <span className="w-24 shrink-0 truncate">{label}</span>
      <span className="font-mono text-xs">{entry.outPid}</span>
      <ArrowRight size={12} aria-hidden className="text-[var(--muted)]" />
      <span className="font-mono text-xs">{entry.inPid ?? "—"}</span>
      <Chip size="sm" variant="soft" color={STATE_COLOR[entry.state]} className="ml-auto">
        {STATE_LABEL[entry.state]}
      </Chip>
    </div>
  );
}
