import { useEffect, useState } from "react";
import { Alert, Card, Chip, EmptyState, Spinner } from "@heroui/react";
import { Cpu } from "lucide-react";
import { AgentError } from "../core/agent/api";
import { gigabytes, linkSpeed, mbps, memoryUsed, sortFindings, splitInterfaces } from "../core/agent/hostFormat";
import type { HostFinding, HostInterface, HostView } from "../core/agent/types";
import { useActiveAgent } from "../hooks/useAgentClient";
import { fmt, t } from "../i18n/es";
import { hrefFor } from "../router";
import { usePrefs } from "../store/prefs";

function duration(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return d > 0 ? `${d} d ${h} h` : h > 0 ? `${h} h ${m} min` : `${m} min`;
}

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex max-w-4xl flex-col gap-5">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">{t.system.title}</h1>
        <p className="text-sm text-[var(--muted)]">{t.system.subtitle}</p>
      </div>
      {children}
    </div>
  );
}

export default function SystemPage() {
  const { agent, client } = useActiveAgent();
  const pollMs = usePrefs((s) => s.pollIntervalMs);
  const [view, setView] = useState<HostView | null>(null);
  const [problem, setProblem] = useState<"unreachable" | "unauthorized" | "disabled" | null>(null);

  useEffect(() => {
    if (!client) return;
    let alive = true;
    setView(null);
    const load = async () => {
      try {
        const next = await client.host();
        if (!alive) return;
        setView(next);
        setProblem(null);
      } catch (error) {
        if (!alive) return;
        const status = error instanceof AgentError ? error.status : 0;
        setProblem(status === 404 ? "disabled" : status === 401 || status === 403 ? "unauthorized" : "unreachable");
      }
    };
    void load();
    const id = setInterval(() => void load(), Math.max(pollMs, 2000));
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [client, pollMs]);

  if (!agent || !client) {
    return (
      <Frame>
        <EmptyState className="flex flex-col items-center gap-2 py-16 text-center">
          <Cpu size={32} aria-hidden className="text-[var(--muted)]" />
          <p className="font-semibold">{t.system.noAgentTitle}</p>
          <p className="max-w-sm text-sm text-[var(--muted)]">{t.system.noAgentBody}</p>
          <a href={hrefFor({ name: "servers" })} className="text-sm font-medium text-[var(--accent)] underline">
            {t.system.noAgentAction}
          </a>
        </EmptyState>
      </Frame>
    );
  }
  if (problem && !view) {
    return (
      <Frame>
        <Alert status="warning">
          <Alert.Content>
            <Alert.Description>
              {problem === "disabled" ? t.system.notEnabled : problem === "unauthorized" ? t.system.unauthorized : t.system.unreachable}
            </Alert.Description>
          </Alert.Content>
        </Alert>
      </Frame>
    );
  }
  if (!view) {
    return (
      <Frame>
        <div className="grid place-items-center py-16">
          <Spinner />
        </div>
      </Frame>
    );
  }

  return (
    <Frame>
      {problem ? (
        <Alert status="warning">
          <Alert.Content>
            <Alert.Description>{t.system.unreachable}</Alert.Description>
          </Alert.Content>
        </Alert>
      ) : null}
      <Recommendations findings={view.findings} />
      <Resources view={view} />
      <Network view={view} />
      <Hardware view={view} />
    </Frame>
  );
}

type Dict = Record<string, { title: string; titleWarn?: string; why: string; action: string }>;

function Recommendations({ findings }: { findings: HostFinding[] }) {
  const texts = t.system.findings as Dict;
  const shown = sortFindings(findings).filter((f) => texts[f.id]);
  return (
    <Card data-testid="recommendations">
      <Card.Header>
        <Card.Title>{t.system.recommendations}</Card.Title>
      </Card.Header>
      <Card.Content className="flex flex-col gap-4">
        {shown.length === 0 ? (
          <p className="text-sm text-[var(--muted)]">{t.system.allGood}</p>
        ) : (
          shown.map((f, i) => {
            const text = texts[f.id]!;
            // The agent sends vendor ids ("tbs"); people read brand names ("TBS").
            const params = { ...f.params };
            if (typeof params.vendor === "string") params.vendor = vendor(params.vendor);
            const title = f.level === "warn" && text.titleWarn ? text.titleWarn : text.title;
            return (
              <div key={`${f.id}-${i}`} data-testid={`finding-${f.id}`} className="flex flex-col gap-1 border-b border-[var(--border)] pb-4 last:border-0 last:pb-0">
                <div className="flex items-start gap-2">
                  <Chip size="sm" variant="soft" color={f.level === "warn" ? "warning" : f.level === "ok" ? "success" : "default"}>
                    {f.level === "warn" ? t.system.levelWarn : f.level === "ok" ? t.system.levelOk : t.system.levelInfo}
                  </Chip>
                  <p className="min-w-0 flex-1 font-semibold">{fmt(title, params)}</p>
                </div>
                <p className="text-sm text-[var(--muted)]">
                  <span className="font-medium text-[var(--foreground)]">{t.system.why}: </span>
                  {text.why}
                </p>
                <p className="text-sm">
                  <span className="font-medium">{t.system.action}: </span>
                  <span className="text-[var(--muted)]">{fmt(text.action, params)}</span>
                </p>
              </div>
            );
          })
        )}
      </Card.Content>
    </Card>
  );
}

function Bar({ label, percent, detail }: { label: string; percent: number; detail: string }) {
  const clamped = Math.min(100, Math.max(0, percent));
  const color = clamped > 90 ? "var(--danger)" : clamped > 75 ? "var(--warning)" : "var(--accent)";
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between text-sm">
        <span className="font-medium">{label}</span>
        <span className="text-[var(--muted)]">{detail}</span>
      </div>
      <div role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(clamped)} className="h-2 overflow-hidden rounded-full bg-[var(--surface-secondary)]">
        <div className="h-full rounded-full" style={{ width: `${clamped}%`, background: color }} />
      </div>
    </div>
  );
}

function Resources({ view }: { view: HostView }) {
  const used = memoryUsed(view.memory.totalKB, view.memory.availableKB);
  return (
    <Card>
      <Card.Header>
        <Card.Title>{t.system.resources}</Card.Title>
      </Card.Header>
      <Card.Content className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Bar label={t.system.cpu} percent={view.cpuUsage} detail={`${Math.round(view.cpuUsage)} % · ${fmt(t.system.cores, { n: view.cpu.cores })}`} />
        <Bar
          label={t.system.memory}
          percent={used}
          detail={fmt(t.system.memoryOf, { used: gigabytes(view.memory.totalKB - view.memory.availableKB), total: gigabytes(view.memory.totalKB) })}
        />
        <p className="text-xs text-[var(--muted)] sm:col-span-2">
          {view.cpu.model} · {t.system.load} {view.load.map((n) => n.toFixed(2)).join(" · ")} · {fmt(t.system.uptime, { time: duration(view.uptimeSec) })}
        </p>
      </Card.Content>
    </Card>
  );
}

function speedText(i: HostInterface): string {
  const s = linkSpeed(i.speedMbps);
  if (!s) return t.system.unknownSpeed;
  return fmt(s.unit === "gbps" ? t.system.gbps : t.system.mbps, { n: s.value });
}

function Network({ view }: { view: HostView }) {
  const { physical, virtual } = splitInterfaces(view.rates);
  const row = (i: HostInterface) => (
    <tr key={i.name} data-testid={`iface-${i.name}`} className="border-t border-[var(--border)]">
      <td className="py-2 pr-3 font-mono text-xs">{i.name}</td>
      <td className="py-2 pr-3">
        <Chip size="sm" variant="soft" color={i.up ? "success" : "default"}>
          {i.up ? t.system.linkUp : t.system.linkDown}
        </Chip>
      </td>
      <td className="py-2 pr-3 text-right tabular-nums">{speedText(i)}</td>
      <td className="py-2 pr-3 text-right tabular-nums">{mbps(i.rxBps)}</td>
      <td className="py-2 pr-3 text-right tabular-nums">{mbps(i.txBps)}</td>
      <td className={`py-2 text-right tabular-nums ${i.recentErrors > 0 ? "text-[var(--danger)]" : ""}`}>{i.recentErrors}</td>
    </tr>
  );
  const table = (rows: HostInterface[]) => (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[34rem] text-sm">
        <thead className="text-left text-xs text-[var(--muted)]">
          <tr>
            <th className="pb-2 pr-3 font-medium">{t.system.iface}</th>
            <th className="pb-2 pr-3 font-medium">{t.system.state}</th>
            <th className="pb-2 pr-3 text-right font-medium">{t.system.speed}</th>
            <th className="pb-2 pr-3 text-right font-medium">{t.system.down} Mbps</th>
            <th className="pb-2 pr-3 text-right font-medium">{t.system.up} Mbps</th>
            <th className="pb-2 text-right font-medium">{t.system.errors}</th>
          </tr>
        </thead>
        <tbody>{rows.map(row)}</tbody>
      </table>
    </div>
  );
  return (
    <Card>
      <Card.Header>
        <Card.Title>{t.system.network}</Card.Title>
      </Card.Header>
      <Card.Content className="flex flex-col gap-3">
        {table(physical)}
        {view.recentUdpDrops > 0 ? (
          <p role="status" className="text-sm text-[var(--warning)]">
            {fmt(t.system.udpDrops, { n: view.recentUdpDrops })}
          </p>
        ) : null}
        {virtual.length > 0 ? (
          <details className="text-sm">
            <summary className="cursor-pointer text-[var(--muted)]">{t.system.virtualIfaces}</summary>
            <div className="mt-2">{table(virtual)}</div>
          </details>
        ) : null}
      </Card.Content>
    </Card>
  );
}

const vendor = (v: string | undefined) => (t.system.vendors as Record<string, string>)[v ?? "other"] ?? v ?? "";

function Hardware({ view }: { view: HostView }) {
  return (
    <Card>
      <Card.Header>
        <Card.Title>{t.system.hardware}</Card.Title>
      </Card.Header>
      <Card.Content className="grid grid-cols-1 gap-5 sm:grid-cols-2">
        <section className="flex flex-col gap-2">
          <h3 className="text-[11px] font-semibold uppercase tracking-wider text-[var(--muted)]">{t.system.gpus}</h3>
          {view.gpus.length === 0 ? (
            <p className="text-sm text-[var(--muted)]">{t.system.noGpus}</p>
          ) : (
            view.gpus.map((g, i) => (
              <p key={i} className="text-sm">
                {vendor(g.vendor)} <span className="font-mono text-xs text-[var(--muted)]">{g.device}</span>
              </p>
            ))
          )}
        </section>
        <section className="flex flex-col gap-2">
          <h3 className="text-[11px] font-semibold uppercase tracking-wider text-[var(--muted)]">{t.system.dvb}</h3>
          {view.dvb.length === 0 && view.pciCards.length === 0 ? <p className="text-sm text-[var(--muted)]">{t.system.noDvb}</p> : null}
          {view.dvb.map((a) => (
            <p key={a.index} className="text-sm">
              {fmt(t.system.adapter, { n: a.index, frontends: a.frontends })}
              {a.vendor ? <span className="text-[var(--muted)]"> · {vendor(a.vendor)}</span> : null}
            </p>
          ))}
          {view.pciCards
            .filter((c) => !c.driver)
            .map((c, i) => (
              <p key={i} className="text-sm">
                {vendor(c.vendor)} <span className="font-mono text-xs text-[var(--muted)]">{c.device}</span>{" "}
                <Chip size="sm" variant="soft" color="warning">
                  {t.system.cardNoDriver}
                </Chip>
              </p>
            ))}
        </section>
      </Card.Content>
    </Card>
  );
}
