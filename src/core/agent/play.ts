import type { AgentView, PlayAction, PlayConfig, PlayPool, PlayRule } from "./types";

export const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,31}$/;
export const MAX_RULES = 200;
export const MAX_POOLS = 100;

export const DEFAULT_PLAY_CONFIG: PlayConfig = {
  enabled: false, requireAuth: false, default: "allow", maxViewers: 200, pools: [], rules: [], users: [],
};

const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;

function isIPv6(text: string): boolean {
  if (!/^[0-9a-fA-F:.]+$/.test(text) || !text.includes(":")) return false;
  try {
    return new URL(`http://[${text}]/`).hostname !== "";
  } catch {
    return false;
  }
}

/** True for a single IP address or a CIDR range, IPv4 or IPv6 (what the agent accepts). */
export function isAddressOrRange(entry: string): boolean {
  const text = entry.trim();
  if (!text) return false;
  const [address, bits, extra] = text.split("/");
  if (extra !== undefined || address === undefined) return false;
  const v4 = IPV4.test(address);
  if (!v4 && !isIPv6(address)) return false;
  if (bits === undefined) return true;
  if (!/^\d{1,3}$/.test(bits)) return false;
  return Number(bits) <= (v4 ? 32 : 128);
}

/** One entry per line or separated by commas/spaces; blanks ignored. */
export function parseEntries(text: string): string[] {
  return text.split(/[\s,;]+/).map((e) => e.trim()).filter(Boolean);
}

export type PlayProblem =
  | { code: "pool-name"; pool: string }
  | { code: "pool-duplicate"; pool: string }
  | { code: "pool-entry"; pool: string; entry: string }
  | { code: "rule-address"; rule: number; entry: string }
  | { code: "rule-pool"; rule: number; pool: string }
  | { code: "rule-empty"; rule: number }
  | { code: "user-name"; user: string }
  | { code: "user-duplicate"; user: string }
  | { code: "auth-no-users" }
  | { code: "viewers" }
  | { code: "too-many" };

/** Mirrors the agent's rules so mistakes show up before saving. */
export function validatePlayConfig(c: PlayConfig): PlayProblem[] {
  const problems: PlayProblem[] = [];
  if (c.pools.length > MAX_POOLS || c.rules.length > MAX_RULES) problems.push({ code: "too-many" });
  if (!Number.isInteger(c.maxViewers) || c.maxViewers < 1 || c.maxViewers > 10000) problems.push({ code: "viewers" });

  const pools = new Set<string>();
  for (const p of c.pools) {
    if (!NAME_PATTERN.test(p.name)) problems.push({ code: "pool-name", pool: p.name });
    else if (pools.has(p.name)) problems.push({ code: "pool-duplicate", pool: p.name });
    pools.add(p.name);
    for (const e of p.entries) if (!isAddressOrRange(e)) problems.push({ code: "pool-entry", pool: p.name, entry: e });
  }
  c.rules.forEach((r, i) => {
    if (r.pool) {
      if (!pools.has(r.pool)) problems.push({ code: "rule-pool", rule: i, pool: r.pool });
    } else if (!r.address?.trim()) problems.push({ code: "rule-empty", rule: i });
    else if (!isAddressOrRange(r.address)) problems.push({ code: "rule-address", rule: i, entry: r.address });
  });
  const users = new Set<string>();
  for (const u of c.users) {
    if (!NAME_PATTERN.test(u.name)) problems.push({ code: "user-name", user: u.name });
    else if (users.has(u.name)) problems.push({ code: "user-duplicate", user: u.name });
    users.add(u.name);
  }
  if (c.requireAuth && c.users.length === 0) problems.push({ code: "auth-no-users" });
  return problems;
}

/** Renaming a pool must keep the rules that point at it working. */
export function renamePool(c: PlayConfig, from: string, to: string): PlayConfig {
  return {
    ...c,
    pools: c.pools.map((p) => (p.name === from ? { ...p, name: to } : p)),
    rules: c.rules.map((r) => (r.pool === from ? { ...r, pool: to } : r)),
  };
}

/** Deleting a pool deletes the rules that used it: a rule without a pool would be rejected. */
export function removePool(c: PlayConfig, name: string): PlayConfig {
  return { ...c, pools: c.pools.filter((p) => p.name !== name), rules: c.rules.filter((r) => r.pool !== name) };
}

/** Puts a rule first, so it wins over everything else. Used by "block this viewer". */
export function prependRule(c: PlayConfig, rule: PlayRule): PlayConfig {
  const exists = c.rules.some((r) => r.action === rule.action && r.address === rule.address && r.pool === rule.pool);
  return exists ? c : { ...c, rules: [rule, ...c.rules] };
}

export function moveRule(rules: PlayRule[], index: number, delta: -1 | 1): PlayRule[] {
  const target = index + delta;
  if (index < 0 || target < 0 || target >= rules.length) return rules;
  const next = [...rules];
  [next[index], next[target]] = [next[target]!, next[index]!];
  return next;
}

/** A single address as a rule address: IPv6 stays as is, IPv4 stays as is. */
export const hostRule = (action: PlayAction, ip: string): PlayRule => ({ action, address: ip });

export const poolsToText = (p: PlayPool): string => p.entries.join("\n");

// ---- playlist ----

export interface PlaylistEntry {
  id: string;
  name: string;
  url: string;
  group: string;
}

/** Same single-line rule as the agent: a line break would split the entry. */
const oneLine = (s: string) => s.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();

export function renderM3u(entries: PlaylistEntry[]): string {
  const lines = ["#EXTM3U"];
  for (const e of entries) {
    lines.push(`#EXTINF:-1 tvg-id="${oneLine(e.id).replace(/"/g, "'")}" group-title="${oneLine(e.group).replace(/"/g, "'")}",${oneLine(e.name)}`);
    lines.push(e.url);
  }
  return `${lines.join("\n")}\n`;
}

/** Services that HTTP play serves: running, not hidden. */
export function playableServices(views: AgentView[]): AgentView[] {
  return views.filter((v) => v.status.state === "running" && !v.service.noPlay);
}

export function agentPlayEntries(agentUrl: string, views: AgentView[], token: string): PlaylistEntry[] {
  const base = agentUrl.replace(/\/+$/, "");
  return playableServices(views).map((v) => ({
    id: v.service.id,
    name: v.service.name,
    group: "Nodo",
    url: `${base}/play/${encodeURIComponent(v.service.id)}${token ? `?token=${encodeURIComponent(token)}` : ""}`,
  }));
}

export function agentPlaylistUrl(agentUrl: string, token: string): string {
  return `${agentUrl.replace(/\/+$/, "")}/play/playlist.m3u${token ? `?token=${encodeURIComponent(token)}` : ""}`;
}
