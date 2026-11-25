import { useCallback, useEffect, useState } from "react";
import { AlertDialog, Alert, Button, Card, Chip, EmptyState, Input, Spinner, toast, useOverlayState } from "@heroui/react";
import { Package, Play, RotateCw, Square, Trash2 } from "lucide-react";
import { AgentError } from "../core/agent/api";
import type { BinariesState, ProcessStatus, ProcessView, ToolInfo } from "../core/agent/types";
import { useActiveAgent } from "../hooks/useAgentClient";
import { usePrefs } from "../store/prefs";
import { fmt, t } from "../i18n/es";
import { hrefFor } from "../router";

const TOOLS = {
  ffmpeg: { name: t.binaries.ffmpegName, why: t.binaries.ffmpegWhy, hint: t.binaries.ffmpegHint },
  tsduck: { name: t.binaries.tsduckName, why: t.binaries.tsduckWhy, hint: t.binaries.tsduckHint },
  dvblast: { name: t.binaries.dvblastName, why: t.binaries.dvblastWhy, hint: t.binaries.dvblastHint },
} as const;

function duration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return h > 0 ? `${h} h ${m} min` : m > 0 ? `${m} min` : `${seconds} s`;
}

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex max-w-3xl flex-col gap-5">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">{t.binaries.title}</h1>
        <p className="text-sm text-[var(--muted)]">{t.binaries.subtitle}</p>
      </div>
      {children}
    </div>
  );
}

const reason = (error: unknown) => (error instanceof AgentError ? (error.detail ?? undefined) : undefined);

export default function BinariesPage() {
  const { agent, client } = useActiveAgent();
  const pollMs = usePrefs((s) => s.pollIntervalMs);
  const [state, setState] = useState<BinariesState | null>(null);
  const [proc, setProc] = useState<ProcessView | null>(null);
  const [problem, setProblem] = useState<"unreachable" | "unauthorized" | "disabled" | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [latest, setLatest] = useState<string | null>(null);
  const [other, setOther] = useState("");
  const [otherError, setOtherError] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const confirm = useOverlayState();

  const load = useCallback(async () => {
    if (!client) return;
    try {
      const next = await client.binaries();
      setState(next);
      setProblem(null);
      if (next.mediamtx.process) setProc(await client.mediaMtxProcess(100).catch(() => null));
    } catch (error) {
      const status = error instanceof AgentError ? error.status : 0;
      setProblem(status === 404 ? "disabled" : status === 401 || status === 403 ? "unauthorized" : "unreachable");
    }
  }, [client]);

  useEffect(() => {
    setState(null);
    void load();
    // Only the process changes by itself; versions change when the operator acts.
    const id = setInterval(() => void load(), Math.max(pollMs, 2000));
    return () => clearInterval(id);
  }, [load, pollMs]);

  if (!agent || !client) {
    return (
      <Frame>
        <EmptyState className="flex flex-col items-center gap-2 py-16 text-center">
          <Package size={32} aria-hidden className="text-[var(--muted)]" />
          <p className="font-semibold">{t.binaries.noAgentTitle}</p>
          <p className="max-w-sm text-sm text-[var(--muted)]">{t.binaries.noAgentBody}</p>
          <a href={hrefFor({ name: "servers" })} className="text-sm font-medium text-[var(--accent)] underline">
            {t.binaries.noAgentAction}
          </a>
        </EmptyState>
      </Frame>
    );
  }
  if (problem) {
    return (
      <Frame>
        <Alert status="warning">
          <Alert.Content>
            <Alert.Description>
              {problem === "disabled" ? t.binaries.notEnabled : problem === "unauthorized" ? t.binaries.unauthorized : t.binaries.unreachable}
            </Alert.Description>
          </Alert.Content>
        </Alert>
      </Frame>
    );
  }
  if (!state) {
    return (
      <Frame>
        <div className="grid place-items-center py-16">
          <Spinner />
        </div>
      </Frame>
    );
  }

  const mtx = state.mediamtx;
  const run = async (key: string, work: () => Promise<unknown>, success?: string) => {
    setBusy(key);
    try {
      await work();
      if (success) toast.success(success);
      await load();
    } catch (error) {
      toast.danger(t.binaries.failed, { description: reason(error) });
    }
    setBusy(null);
  };

  const checkLatest = async () => {
    setBusy("latest");
    try {
      setLatest(await client.latestMediaMtx());
    } catch (error) {
      toast.danger(t.binaries.failed, { description: reason(error) });
    }
    setBusy(null);
  };

  const installOther = () => {
    const version = other.trim();
    if (!/^v\d+\.\d+\.\d+$/.test(version)) {
      setOtherError(true);
      return;
    }
    setOtherError(false);
    void run("install", () => client.installMediaMtx(version), t.binaries.installed).then(() => setOther(""));
  };

  const installing = busy === "install" || busy === "install-latest";

  return (
    <Frame>
      <Card>
        <Card.Header className="flex flex-row items-center gap-2">
          <Card.Title className="flex-1">{t.binaries.mediamtx}</Card.Title>
          <Chip size="sm" variant="soft" color={mtx.current ? "success" : "default"}>
            {mtx.current ? `${t.binaries.inUse}: ${mtx.current}` : t.binaries.none}
          </Chip>
        </Card.Header>
        <Card.Content className="flex flex-col gap-5">
          <p className="text-sm text-[var(--muted)]">{t.binaries.mediamtxWhy}</p>

          <section className="flex flex-col gap-2">
            <h3 className="text-[11px] font-semibold uppercase tracking-wider text-[var(--muted)]">{t.binaries.installedTitle}</h3>
            {mtx.installed.length === 0 ? (
              <p className="text-sm text-[var(--muted)]">{t.binaries.noneInstalled}</p>
            ) : (
              mtx.installed.map((version) => (
                <div key={version} data-testid={`version-${version}`} className="flex items-center gap-2 rounded-lg bg-[var(--surface-secondary)] px-3 py-2">
                  <span className="flex-1 font-mono text-sm">{version}</span>
                  {version === mtx.current ? (
                    <Chip size="sm" variant="soft" color="success">
                      {t.binaries.inUse}
                    </Chip>
                  ) : (
                    <>
                      <Button size="sm" variant="tertiary" isDisabled={busy !== null} onPress={() => void run(`use-${version}`, () => client.useMediaMtx(version), t.binaries.switched)}>
                        {t.binaries.use}
                      </Button>
                      <Button
                        size="sm"
                        variant="danger-soft"
                        isIconOnly
                        aria-label={`${t.binaries.remove} ${version}`}
                        isDisabled={busy !== null}
                        onPress={() => {
                          setRemoving(version);
                          confirm.open();
                        }}
                      >
                        <Trash2 size={14} aria-hidden />
                      </Button>
                    </>
                  )}
                </div>
              ))
            )}
          </section>

          <section className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="secondary" size="sm" onPress={checkLatest} isPending={busy === "latest"} isDisabled={busy !== null && busy !== "latest"}>
                {busy === "latest" ? t.binaries.checking : t.binaries.checkLatest}
              </Button>
              {latest ? (
                mtx.installed.includes(latest) ? (
                  <span className="text-sm text-[var(--muted)]">
                    {fmt(t.binaries.latestIs, { version: latest })} · {t.binaries.upToDate}
                  </span>
                ) : (
                  <>
                    <span className="text-sm">{fmt(t.binaries.latestIs, { version: latest })}</span>
                    <Button variant="primary" size="sm" isPending={busy === "install-latest"} isDisabled={busy !== null && busy !== "install-latest"} onPress={() => void run("install-latest", () => client.installMediaMtx(latest), t.binaries.installed)}>
                      {fmt(t.binaries.install, { version: latest })}
                    </Button>
                  </>
                )
              ) : null}
            </div>
            <div className="flex flex-wrap items-start gap-2">
              <div className="flex flex-col gap-1">
                <Input aria-label={t.binaries.otherVersion} placeholder={t.binaries.otherPlaceholder} value={other} onChange={(event) => setOther(event.target.value)} className="w-40 font-mono" autoCapitalize="none" spellCheck={false} />
                {otherError ? <p role="alert" className="text-xs text-[var(--danger)]">{t.binaries.badVersion}</p> : null}
              </div>
              <Button size="sm" variant="secondary" isPending={busy === "install"} isDisabled={busy !== null && busy !== "install"} onPress={installOther}>
                {t.binaries.installOther}
              </Button>
            </div>
            {installing ? (
              <p role="status" className="text-xs text-[var(--muted)]">
                {t.binaries.installing} {t.binaries.installingHint}
              </p>
            ) : null}
          </section>
        </Card.Content>
      </Card>

      <ProcessCard
        status={mtx.process}
        view={proc}
        busy={busy}
        hasVersion={Boolean(mtx.current)}
        onAction={(action) => void run(`proc-${action}`, () => client.controlMediaMtx(action))}
      />

      <Card>
        <Card.Header>
          <Card.Title>{t.binaries.tools}</Card.Title>
        </Card.Header>
        <Card.Content className="flex flex-col gap-4">
          {state.tools.map((tool) => (
            <ToolRow key={tool.id} tool={tool} />
          ))}
        </Card.Content>
      </Card>

      <AlertDialog isOpen={confirm.isOpen} onOpenChange={confirm.setOpen}>
        <AlertDialog.Backdrop>
          <AlertDialog.Container>
            <AlertDialog.Dialog>
              <AlertDialog.Header>
                <AlertDialog.Heading>{t.binaries.removeTitle}</AlertDialog.Heading>
              </AlertDialog.Header>
              <AlertDialog.Body>
                <p>{fmt(t.binaries.removeBody, { version: removing ?? "" })}</p>
              </AlertDialog.Body>
              <AlertDialog.Footer>
                <Button variant="tertiary" onPress={confirm.close}>
                  {t.binaries.cancel}
                </Button>
                <Button
                  variant="danger"
                  onPress={() => {
                    const version = removing;
                    confirm.close();
                    if (version) void run(`remove-${version}`, () => client.removeMediaMtx(version), t.binaries.removed);
                  }}
                >
                  {t.binaries.remove}
                </Button>
              </AlertDialog.Footer>
            </AlertDialog.Dialog>
          </AlertDialog.Container>
        </AlertDialog.Backdrop>
      </AlertDialog>
    </Frame>
  );
}

function ProcessCard({
  status, view, busy, hasVersion, onAction,
}: {
  status: ProcessStatus | undefined;
  view: ProcessView | null;
  busy: string | null;
  hasVersion: boolean;
  onAction: (action: "start" | "stop" | "restart") => void;
}) {
  if (!status) {
    return (
      <Card>
        <Card.Header>
          <Card.Title>{t.binaries.process}</Card.Title>
        </Card.Header>
        <Card.Content>
          <p className="text-sm text-[var(--muted)]">{t.binaries.processNeedsConfig}</p>
        </Card.Content>
      </Card>
    );
  }
  const live = view?.status ?? status;
  const uptime = live.state === "running" && live.since ? Math.max(0, Math.floor(Date.now() / 1000 - live.since)) : null;
  return (
    <Card data-testid="process-card">
      <Card.Header className="flex flex-row items-center gap-2">
        <Card.Title className="flex-1">{t.binaries.process}</Card.Title>
        <Chip size="sm" variant="soft" color={live.state === "running" ? "success" : live.state === "crashed" ? "danger" : "default"}>
          {live.state === "running" ? t.binaries.running : live.state === "crashed" ? t.binaries.crashed : t.binaries.stopped}
        </Chip>
      </Card.Header>
      <Card.Content className="flex flex-col gap-4">
        <p className="text-sm text-[var(--muted)]">{t.binaries.processHelp}</p>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-[var(--muted)]">
          {uptime !== null ? <span>{fmt(t.binaries.uptime, { time: duration(uptime) })}</span> : null}
          {live.restarts > 0 ? <span className="text-[var(--warning)]">{fmt(t.binaries.restarts, { n: live.restarts })}</span> : null}
          {live.lastExit && live.state !== "running" ? <span>{fmt(t.binaries.lastExit, { reason: live.lastExit })}</span> : null}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {live.state === "stopped" ? (
            <Button variant="primary" size="sm" isDisabled={!hasVersion || busy !== null} onPress={() => onAction("start")}>
              <Play size={14} aria-hidden />
              {t.binaries.start}
            </Button>
          ) : (
            <>
              <Button variant="secondary" size="sm" isDisabled={busy !== null} onPress={() => onAction("restart")}>
                <RotateCw size={14} aria-hidden />
                {t.binaries.restart}
              </Button>
              <Button variant="secondary" size="sm" isDisabled={busy !== null} onPress={() => onAction("stop")}>
                <Square size={14} aria-hidden />
                {t.binaries.stop}
              </Button>
            </>
          )}
        </div>
        <p className="text-xs text-[var(--muted)]">{t.binaries.restartNote}</p>
        <details className="rounded-xl border border-[var(--border)] p-3 text-sm">
          <summary className="cursor-pointer font-medium">{t.binaries.logs}</summary>
          <pre className="mt-2 max-h-64 overflow-auto font-mono text-xs">
            {view && view.logs.length > 0 ? view.logs.join("\n") : t.binaries.noLogs}
          </pre>
        </details>
      </Card.Content>
    </Card>
  );
}

function ToolRow({ tool }: { tool: ToolInfo }) {
  const info = TOOLS[tool.id as keyof typeof TOOLS];
  if (!info) return null;
  return (
    <div data-testid={`tool-${tool.id}`} className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <span className="flex-1 font-semibold">{info.name}</span>
        <Chip size="sm" variant="soft" color={tool.found ? "success" : "default"}>
          {tool.found ? t.binaries.found : t.binaries.missing}
        </Chip>
      </div>
      <p className="text-sm text-[var(--muted)]">{info.why}</p>
      {tool.found ? (
        <p className="truncate font-mono text-xs text-[var(--muted)]" title={tool.path}>
          {tool.version || tool.path}
        </p>
      ) : (
        <p className="text-xs text-[var(--muted)]">{info.hint}</p>
      )}
    </div>
  );
}
