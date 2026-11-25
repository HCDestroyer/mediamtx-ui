import { useCallback, useEffect, useMemo, useState } from "react";
import { Alert, Button, Card, Chip, EmptyState, Input, ListBox, Select, Spinner, Switch, TextField, toast } from "@heroui/react";
import { ArrowDown, ArrowUp, Ban, Copy, Download, PlayCircle, Plus, Trash2 } from "lucide-react";
import { AgentError } from "../core/agent/api";
import {
  agentPlayEntries, agentPlaylistUrl, hostRule, moveRule, parseEntries, poolsToText, prependRule, removePool, renamePool, renderM3u,
  validatePlayConfig, type PlaylistEntry, type PlayProblem,
} from "../core/agent/play";
import type { AgentView, PlayAction, PlayClient, PlayConfig, PlayRule } from "../core/agent/types";
import { copyText } from "../core/clipboard";
import { downloadText } from "../core/download";
import { formatBytes, formatSince } from "../core/format";
import { hostOf, buildReadUrls } from "../core/mediamtx/urls";
import { shareText } from "../core/native";
import { useActiveAgent } from "../hooks/useAgentClient";
import { useActiveServer } from "../hooks/useActiveConnection";
import { fmt, t } from "../i18n/es";
import { hrefFor } from "../router";
import { useChannels } from "../store/channels";

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex max-w-3xl flex-col gap-5">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">{t.play.title}</h1>
        <p className="text-sm text-[var(--muted)]">{t.play.subtitle}</p>
      </div>
      {children}
    </div>
  );
}

function problemText(p: PlayProblem): string {
  const texts = t.play.problems as Record<string, string>;
  const base = texts[p.code] ?? p.code;
  const values: Record<string, string | number> = {};
  if ("pool" in p) values.pool = p.pool;
  if ("entry" in p) values.entry = p.entry;
  if ("user" in p) values.user = p.user;
  if ("rule" in p) values.n = p.rule + 1;
  return fmt(base, values);
}

const same = (a: PlayConfig, b: PlayConfig) => JSON.stringify(a) === JSON.stringify(b);

function Toggle({ label, help, checked, onChange }: { label: string; help?: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex flex-col gap-1">
      <Switch isSelected={checked} onChange={onChange} aria-label={label} className="flex-row items-center gap-3">
        <Switch.Control>
          <Switch.Thumb />
        </Switch.Control>
        <Switch.Content>
          <span className="text-sm font-medium">{label}</span>
        </Switch.Content>
      </Switch>
      {help ? <p className="text-xs text-[var(--muted)]">{help}</p> : null}
    </div>
  );
}

function ActionSelect({ value, onChange, label }: { value: PlayAction; onChange: (v: PlayAction) => void; label: string }) {
  return (
    <Select selectedKey={value} onSelectionChange={(k) => onChange(k === "deny" ? "deny" : "allow")} aria-label={label} className="w-36">
      <Select.Trigger>
        <Select.Value />
        <Select.Indicator />
      </Select.Trigger>
      <Select.Popover>
        <ListBox>
          <ListBox.Item id="allow" textValue={t.play.allow}>{t.play.allow}</ListBox.Item>
          <ListBox.Item id="deny" textValue={t.play.deny}>{t.play.deny}</ListBox.Item>
        </ListBox>
      </Select.Popover>
    </Select>
  );
}

export default function PlayPage() {
  const { agent, client } = useActiveAgent();
  const { connection } = useActiveServer();
  const channels = useChannels((s) => s.channels);
  const ports = useChannels((s) => s.ports);
  const [saved, setSaved] = useState<PlayConfig | null>(null);
  const [draft, setDraft] = useState<PlayConfig | null>(null);
  const [problem, setProblem] = useState<"unreachable" | "unauthorized" | null>(null);
  const [saving, setSaving] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const [viewers, setViewers] = useState<PlayClient[]>([]);
  const [services, setServices] = useState<AgentView[]>([]);
  const [newUser, setNewUser] = useState("");
  const [forUser, setForUser] = useState("");
  const [withMediamtx, setWithMediamtx] = useState(true);
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(async () => {
    if (!client) return;
    try {
      const config = await client.playConfig();
      setSaved(config);
      setDraft((current) => current ?? config);
      setProblem(null);
    } catch (error) {
      setProblem(error instanceof AgentError && (error.status === 401 || error.status === 403) ? "unauthorized" : "unreachable");
    }
  }, [client]);

  useEffect(() => {
    setSaved(null);
    setDraft(null);
    void load();
  }, [load]);

  // Viewers and services refresh by themselves; the configuration is only reloaded after saving.
  useEffect(() => {
    if (!client) return;
    let alive = true;
    const tick = async () => {
      const [list, views] = await Promise.all([client.playClients().catch(() => null), client.list().catch(() => null)]);
      if (!alive) return;
      if (list) setViewers(list);
      if (views) setServices(views);
      setNow(Date.now());
    };
    void tick();
    const id = setInterval(() => void tick(), 2500);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [client]);

  const problems = useMemo(() => (draft ? validatePlayConfig(draft) : []), [draft]);
  const dirty = Boolean(saved && draft && !same(saved, draft));

  if (!agent || !client) {
    return (
      <Frame>
        <EmptyState className="flex flex-col items-center gap-2 py-16 text-center">
          <PlayCircle size={32} aria-hidden className="text-[var(--muted)]" />
          <p className="font-semibold">{t.play.noAgentTitle}</p>
          <p className="max-w-sm text-sm text-[var(--muted)]">{t.play.noAgentBody}</p>
          <a href={hrefFor({ name: "servers" })} className="text-sm font-medium text-[var(--accent)] underline">
            {t.play.noAgentAction}
          </a>
        </EmptyState>
      </Frame>
    );
  }
  if (problem && !draft) {
    return (
      <Frame>
        <Alert status="warning">
          <Alert.Content>
            <Alert.Description>{problem === "unauthorized" ? t.play.unauthorized : t.play.unreachable}</Alert.Description>
          </Alert.Content>
        </Alert>
      </Frame>
    );
  }
  if (!draft || !saved) {
    return (
      <Frame>
        <div className="grid place-items-center py-16">
          <Spinner />
        </div>
      </Frame>
    );
  }

  const edit = (changes: Partial<PlayConfig>) => {
    setDraft({ ...draft, ...changes });
    setServerError(null);
  };
  const setRule = (i: number, rule: PlayRule) => edit({ rules: draft.rules.map((r, j) => (j === i ? rule : r)) });

  const save = async () => {
    setSaving(true);
    setServerError(null);
    try {
      const applied = await client.setPlayConfig(draft);
      setSaved(applied);
      setDraft(applied);
      toast.success(t.play.saved);
    } catch (error) {
      setServerError(error instanceof AgentError ? (error.detail ?? t.play.failed) : t.play.failed);
    }
    setSaving(false);
  };

  const block = async (ip: string) => {
    try {
      const applied = await client.setPlayConfig(prependRule(saved, hostRule("deny", ip)));
      setSaved(applied);
      setDraft(applied);
      toast.success(fmt(t.play.blocked, { ip }));
    } catch (error) {
      toast.danger(t.play.failed, { description: error instanceof AgentError ? (error.detail ?? undefined) : undefined });
    }
  };

  // ---- playlist: services of the agent plus, optionally, the live channels of MediaMTX over HLS ----
  const user = saved.users.find((u) => u.name === forUser) ?? saved.users[0];
  const token = saved.requireAuth ? (user?.token ?? "") : "";
  const host = connection.active ? hostOf(connection.active.endpoint.apiUrl) : "";
  const mtxEntries: PlaylistEntry[] =
    withMediamtx && ports && host
      ? channels
          .filter((c) => c.live)
          .flatMap((c) => {
            const hls = buildReadUrls(host, c.name, ports).find((e) => e.protocol === "hls");
            return hls ? [{ id: c.name, name: c.name, group: "MediaMTX", url: hls.url }] : [];
          })
      : [];
  const agentEntries = agentPlayEntries(agent.url, services, token);
  const entries = [...agentEntries, ...mtxEntries];
  const needsSave = draft.users.some((u) => !u.token);

  return (
    <Frame>
      {problem ? (
        <Alert status="warning">
          <Alert.Content>
            <Alert.Description>{t.play.unreachable}</Alert.Description>
          </Alert.Content>
        </Alert>
      ) : null}

      <Card>
        <Card.Header>
          <Card.Title>{t.play.general}</Card.Title>
        </Card.Header>
        <Card.Content className="flex flex-col gap-4">
          <Toggle label={t.play.enabled} help={t.play.enabledHelp} checked={draft.enabled} onChange={(enabled) => edit({ enabled })} />
          <Toggle label={t.play.requireAuth} help={t.play.requireAuthHelp} checked={draft.requireAuth} onChange={(requireAuth) => edit({ requireAuth })} />
          <div className="flex flex-wrap items-end gap-4">
            <div className="flex flex-col gap-1">
              <span className="text-sm font-medium">{t.play.defaultPolicy}</span>
              <ActionSelect value={draft.default} onChange={(v) => edit({ default: v })} label={t.play.defaultPolicy} />
            </div>
            <TextField value={String(draft.maxViewers)} onChange={(v) => edit({ maxViewers: Number(v.replace(/\D/g, "")) || 0 })} aria-label={t.play.maxViewers} className="w-40">
              <span className="text-sm font-medium">{t.play.maxViewers}</span>
              <Input inputMode="numeric" />
            </TextField>
          </div>
        </Card.Content>
      </Card>

      <Card>
        <Card.Header>
          <Card.Title>{t.play.users}</Card.Title>
        </Card.Header>
        <Card.Content className="flex flex-col gap-3">
          <p className="text-xs text-[var(--muted)]">{t.play.usersHelp}</p>
          {draft.users.length === 0 ? <p className="text-sm text-[var(--muted)]">{t.play.noUsers}</p> : null}
          {draft.users.map((u, i) => (
            <div key={u.name} data-testid={`user-${u.name}`} className="flex flex-wrap items-center gap-2 rounded-lg bg-[var(--surface-secondary)] px-3 py-2">
              <span className="font-medium">{u.name}</span>
              <code className="min-w-0 flex-1 truncate font-mono text-xs text-[var(--muted)]">{u.token ? `${u.token.slice(0, 6)}…${u.token.slice(-4)}` : t.play.newToken}</code>
              {u.token ? (
                <Button size="sm" variant="tertiary" isIconOnly aria-label={`${t.play.copyToken} ${u.name}`} onPress={async () => { await copyText(u.token); toast.success(t.play.tokenCopied); }}>
                  <Copy size={14} aria-hidden />
                </Button>
              ) : null}
              <Button size="sm" variant="tertiary" onPress={() => edit({ users: draft.users.map((x, j) => (j === i ? { ...x, token: "" } : x)) })}>
                {t.play.regenerate}
              </Button>
              <Button size="sm" variant="danger-soft" isIconOnly aria-label={`${t.play.removeUser} ${u.name}`} onPress={() => edit({ users: draft.users.filter((_, j) => j !== i) })}>
                <Trash2 size={14} aria-hidden />
              </Button>
            </div>
          ))}
          <div className="flex items-end gap-2">
            <TextField value={newUser} onChange={setNewUser} aria-label={t.play.userName} className="min-w-0 flex-1">
              <Input placeholder={t.play.userName} autoCapitalize="none" spellCheck={false} />
            </TextField>
            <Button
              size="sm"
              variant="secondary"
              isDisabled={!newUser.trim()}
              onPress={() => {
                edit({ users: [...draft.users, { name: newUser.trim(), token: "" }] });
                setNewUser("");
              }}
            >
              <Plus size={14} aria-hidden />
              {t.play.addUser}
            </Button>
          </div>
        </Card.Content>
      </Card>

      <Card>
        <Card.Header>
          <Card.Title>{t.play.pools}</Card.Title>
        </Card.Header>
        <Card.Content className="flex flex-col gap-3">
          <p className="text-xs text-[var(--muted)]">{t.play.poolsHelp}</p>
          {draft.pools.length === 0 ? <p className="text-sm text-[var(--muted)]">{t.play.noPools}</p> : null}
          {draft.pools.map((p, i) => (
            <div key={i} data-testid={`pool-${i}`} className="flex flex-col gap-2 rounded-lg bg-[var(--surface-secondary)] p-3">
              <div className="flex items-center gap-2">
                <TextField value={p.name} onChange={(name) => setDraft(renamePool(draft, p.name, name))} aria-label={t.play.poolName} className="min-w-0 flex-1">
                  <Input placeholder={t.play.poolName} autoCapitalize="none" spellCheck={false} />
                </TextField>
                <Button size="sm" variant="danger-soft" isIconOnly aria-label={`${t.play.removePool} ${p.name}`} onPress={() => setDraft(removePool(draft, p.name))}>
                  <Trash2 size={14} aria-hidden />
                </Button>
              </div>
              <textarea
                aria-label={`${t.play.poolEntries} ${p.name}`}
                value={poolsToText(p)}
                onChange={(event) => edit({ pools: draft.pools.map((x, j) => (j === i ? { ...x, entries: parseEntries(event.target.value) } : x)) })}
                placeholder={t.play.poolPlaceholder}
                rows={3}
                spellCheck={false}
                className="w-full rounded-xl border border-[var(--border)] bg-[var(--field-background)] p-2 font-mono text-xs outline-none focus-visible:border-[var(--focus)]"
              />
            </div>
          ))}
          <div>
            <Button size="sm" variant="secondary" onPress={() => edit({ pools: [...draft.pools, { name: `pool${draft.pools.length + 1}`, entries: [] }] })}>
              <Plus size={14} aria-hidden />
              {t.play.addPool}
            </Button>
          </div>
        </Card.Content>
      </Card>

      <Card>
        <Card.Header>
          <Card.Title>{t.play.rules}</Card.Title>
        </Card.Header>
        <Card.Content className="flex flex-col gap-3">
          <p className="text-xs text-[var(--muted)]">{t.play.rulesHelp}</p>
          {draft.rules.length === 0 ? <p className="text-sm text-[var(--muted)]">{t.play.noRules}</p> : null}
          {draft.rules.map((r, i) => (
            <div key={i} data-testid={`rule-${i}`} className="flex flex-wrap items-center gap-2 rounded-lg bg-[var(--surface-secondary)] px-3 py-2">
              <span className="w-5 text-xs text-[var(--muted)]">{i + 1}</span>
              <ActionSelect value={r.action} onChange={(action) => setRule(i, { ...r, action })} label={`${t.play.ruleAction} ${i + 1}`} />
              <Select
                selectedKey={r.pool !== undefined ? "pool" : "address"}
                onSelectionChange={(k) => setRule(i, k === "pool" ? { action: r.action, pool: draft.pools[0]?.name ?? "" } : { action: r.action, address: "" })}
                aria-label={`${t.play.ruleSource} ${i + 1}`}
                className="w-36"
              >
                <Select.Trigger>
                  <Select.Value />
                  <Select.Indicator />
                </Select.Trigger>
                <Select.Popover>
                  <ListBox>
                    <ListBox.Item id="address" textValue={t.play.sourceAddress}>{t.play.sourceAddress}</ListBox.Item>
                    <ListBox.Item id="pool" textValue={t.play.sourcePool}>{t.play.sourcePool}</ListBox.Item>
                  </ListBox>
                </Select.Popover>
              </Select>
              {r.pool !== undefined ? (
                <Select selectedKey={r.pool || null} onSelectionChange={(k) => setRule(i, { action: r.action, pool: String(k) })} aria-label={`${t.play.sourcePool} ${i + 1}`} className="min-w-32 flex-1" placeholder={t.play.sourcePool}>
                  <Select.Trigger>
                    <Select.Value />
                    <Select.Indicator />
                  </Select.Trigger>
                  <Select.Popover>
                    <ListBox>
                      {draft.pools.map((p) => (
                        <ListBox.Item key={p.name} id={p.name} textValue={p.name}>{p.name}</ListBox.Item>
                      ))}
                    </ListBox>
                  </Select.Popover>
                </Select>
              ) : (
                <TextField value={r.address ?? ""} onChange={(address) => setRule(i, { action: r.action, address })} aria-label={`${t.play.sourceAddress} ${i + 1}`} className="min-w-32 flex-1">
                  <Input placeholder={t.play.addressPlaceholder} autoCapitalize="none" spellCheck={false} className="font-mono" />
                </TextField>
              )}
              <Button size="sm" variant="ghost" isIconOnly aria-label={`${t.play.moveUp} ${i + 1}`} isDisabled={i === 0} onPress={() => edit({ rules: moveRule(draft.rules, i, -1) })}>
                <ArrowUp size={14} aria-hidden />
              </Button>
              <Button size="sm" variant="ghost" isIconOnly aria-label={`${t.play.moveDown} ${i + 1}`} isDisabled={i === draft.rules.length - 1} onPress={() => edit({ rules: moveRule(draft.rules, i, 1) })}>
                <ArrowDown size={14} aria-hidden />
              </Button>
              <Button size="sm" variant="danger-soft" isIconOnly aria-label={`${t.play.removeRule} ${i + 1}`} onPress={() => edit({ rules: draft.rules.filter((_, j) => j !== i) })}>
                <Trash2 size={14} aria-hidden />
              </Button>
            </div>
          ))}
          <div>
            <Button size="sm" variant="secondary" onPress={() => edit({ rules: [...draft.rules, { action: "allow", address: "" }] })}>
              <Plus size={14} aria-hidden />
              {t.play.addRule}
            </Button>
          </div>
        </Card.Content>
      </Card>

      {problems.length > 0 ? (
        <Alert status="danger">
          <Alert.Content>
            <ul className="list-disc pl-4 text-sm">
              {problems.map((p, i) => (
                <li key={i}>{problemText(p)}</li>
              ))}
            </ul>
          </Alert.Content>
        </Alert>
      ) : null}
      {serverError ? (
        <p role="alert" className="text-sm text-[var(--danger)]">
          {serverError}
        </p>
      ) : null}
      <div className="sticky bottom-[calc(env(safe-area-inset-bottom,0px)+4.5rem)] z-10 flex flex-wrap items-center gap-2 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-3 lg:bottom-4">
        <Button variant="primary" onPress={save} isPending={saving} isDisabled={!dirty || problems.length > 0}>
          {saving ? t.play.saving : t.play.save}
        </Button>
        {dirty ? (
          <Button variant="ghost" onPress={() => { setDraft(saved); setServerError(null); }}>
            {t.play.discard}
          </Button>
        ) : null}
        <Chip size="sm" variant="soft" color={dirty ? "warning" : "success"}>
          {dirty ? t.play.unsaved : t.play.saved}
        </Chip>
      </div>

      <Card>
        <Card.Header>
          <Card.Title>{t.play.viewers}</Card.Title>
        </Card.Header>
        <Card.Content className="flex flex-col gap-2">
          {viewers.length === 0 ? <p className="text-sm text-[var(--muted)]">{t.play.noViewers}</p> : null}
          {viewers.map((v) => (
            <div key={v.id} data-testid={`viewer-${v.id}`} className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg bg-[var(--surface-secondary)] px-3 py-2 text-sm">
              <span className="font-medium">{v.service}</span>
              <code className="font-mono text-xs text-[var(--muted)]">{v.ip}</code>
              {v.user ? <Chip size="sm" variant="soft">{v.user}</Chip> : null}
              <span className="text-xs text-[var(--muted)]">{formatSince(new Date(v.since * 1000).toISOString(), now)} · {formatBytes(v.bytes)}</span>
              <Button size="sm" variant="danger-soft" className="ml-auto" isDisabled={dirty} onPress={() => void block(v.ip)}>
                <Ban size={14} aria-hidden />
                {t.play.blockIp}
              </Button>
            </div>
          ))}
          {dirty && viewers.length > 0 ? <p className="text-xs text-[var(--muted)]">{t.play.saveFirst}</p> : null}
        </Card.Content>
      </Card>

      <Card data-testid="playlist-card">
        <Card.Header>
          <Card.Title>{t.play.playlist}</Card.Title>
        </Card.Header>
        <Card.Content className="flex flex-col gap-3">
          <p className="text-xs text-[var(--muted)]">{t.play.playlistHelp}</p>
          {saved.requireAuth && saved.users.length > 0 ? (
            <div className="flex flex-col gap-1">
              <span className="text-sm font-medium">{t.play.forUser}</span>
              <Select selectedKey={user?.name ?? null} onSelectionChange={(k) => setForUser(String(k))} aria-label={t.play.forUser} className="w-56">
                <Select.Trigger>
                  <Select.Value />
                  <Select.Indicator />
                </Select.Trigger>
                <Select.Popover>
                  <ListBox>
                    {saved.users.map((u) => (
                      <ListBox.Item key={u.name} id={u.name} textValue={u.name}>{u.name}</ListBox.Item>
                    ))}
                  </ListBox>
                </Select.Popover>
              </Select>
            </div>
          ) : null}
          <Toggle label={t.play.includeMediamtx} checked={withMediamtx} onChange={setWithMediamtx} />
          <p data-testid="playlist-count" className="text-sm">
            {fmt(t.play.playlistCount, { n: entries.length, agent: agentEntries.length, mtx: mtxEntries.length })}
          </p>
          {needsSave ? <p className="text-xs text-[var(--warning)]">{t.play.playlistNeedsSave}</p> : null}
          {!saved.enabled ? <p className="text-xs text-[var(--warning)]">{t.play.playlistOff}</p> : null}
          <div className="flex flex-wrap gap-2">
            <Button
              variant="secondary"
              onPress={async () => {
                await copyText(agentPlaylistUrl(agent.url, token));
                toast.success(t.play.linkCopied);
              }}
            >
              <Copy size={14} aria-hidden />
              {t.play.copyLink}
            </Button>
            <Button
              variant="primary"
              isDisabled={entries.length === 0}
              onPress={async () => {
                const text = renderM3u(entries);
                if (!(await shareText(t.play.shareTitle, text, t.play.shareDialog).catch(() => false))) downloadText("nodo.m3u", text, "audio/x-mpegurl");
                toast.success(t.play.downloaded);
              }}
            >
              <Download size={14} aria-hidden />
              {t.play.download}
            </Button>
          </div>
        </Card.Content>
      </Card>
    </Frame>
  );
}
