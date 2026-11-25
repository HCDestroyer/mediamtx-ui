import { describe, expect, it } from "vitest";
import {
  agentPlayEntries, agentPlaylistUrl, DEFAULT_PLAY_CONFIG, hostRule, isAddressOrRange, moveRule, parseEntries, prependRule,
  removePool, renamePool, renderM3u, validatePlayConfig,
} from "./play";
import type { AgentView, PlayConfig } from "./types";

const cfg = (over: Partial<PlayConfig> = {}): PlayConfig => ({ ...DEFAULT_PLAY_CONFIG, ...over });

describe("isAddressOrRange", () => {
  it("accepts IPv4/IPv6 addresses and ranges", () => {
    for (const ok of ["10.0.0.1", "192.168.1.0/24", "0.0.0.0/0", "::1", "2001:db8::/32", "fe80::1/128", " 10.1.1.1 "]) expect(isAddressOrRange(ok), ok).toBe(true);
  });
  it("rejects everything else", () => {
    for (const bad of ["", "300.1.1.1", "10.0.0", "10.0.0.0/33", "2001:db8::/129", "10.0.0.0/", "10.0.0.0/8/8", "host.example", "10.0.0.1:80", "::g", "10.0.0.0/ab"]) {
      expect(isAddressOrRange(bad), bad).toBe(false);
    }
  });
});

describe("parseEntries", () => {
  it("splits on lines, commas, semicolons and spaces", () => {
    expect(parseEntries("10.0.0.1\n10.0.0.2, 10.0.0.3;  10.0.0.4\n\n")).toEqual(["10.0.0.1", "10.0.0.2", "10.0.0.3", "10.0.0.4"]);
    expect(parseEntries("  ")).toEqual([]);
  });
});

describe("validatePlayConfig", () => {
  it("accepts a good configuration", () => {
    const c = cfg({ pools: [{ name: "hotel", entries: ["10.0.0.0/24"] }], rules: [{ action: "allow", pool: "hotel" }, { action: "deny", address: "1.2.3.4" }], users: [{ name: "ana", token: "" }] });
    expect(validatePlayConfig(c)).toEqual([]);
  });
  it("reports each kind of mistake", () => {
    const codes = (c: PlayConfig) => validatePlayConfig(c).map((p) => p.code);
    expect(codes(cfg({ pools: [{ name: "bad name", entries: [] }] }))).toContain("pool-name");
    expect(codes(cfg({ pools: [{ name: "a", entries: [] }, { name: "a", entries: [] }] }))).toContain("pool-duplicate");
    expect(codes(cfg({ pools: [{ name: "a", entries: ["nope"] }] }))).toContain("pool-entry");
    expect(codes(cfg({ rules: [{ action: "allow", pool: "missing" }] }))).toContain("rule-pool");
    expect(codes(cfg({ rules: [{ action: "allow", address: "" }] }))).toContain("rule-empty");
    expect(codes(cfg({ rules: [{ action: "allow", address: "x" }] }))).toContain("rule-address");
    expect(codes(cfg({ users: [{ name: "a b", token: "" }] }))).toContain("user-name");
    expect(codes(cfg({ users: [{ name: "a", token: "" }, { name: "a", token: "" }] }))).toContain("user-duplicate");
    expect(codes(cfg({ requireAuth: true }))).toContain("auth-no-users");
    expect(codes(cfg({ maxViewers: 0 }))).toContain("viewers");
  });
});

describe("rule helpers", () => {
  const base = cfg({ pools: [{ name: "a", entries: [] }, { name: "b", entries: [] }], rules: [{ action: "allow", pool: "a" }, { action: "deny", pool: "b" }] });
  it("renaming a pool keeps its rules attached", () => {
    const r = renamePool(base, "a", "c");
    expect(r.pools.map((p) => p.name)).toEqual(["c", "b"]);
    expect(r.rules[0]).toEqual({ action: "allow", pool: "c" });
    expect(validatePlayConfig(r)).toEqual([]);
  });
  it("deleting a pool deletes its rules, leaving a valid configuration", () => {
    const r = removePool(base, "a");
    expect(r.rules).toEqual([{ action: "deny", pool: "b" }]);
    expect(validatePlayConfig(r)).toEqual([]);
  });
  it("prepends a block rule once", () => {
    const once = prependRule(base, hostRule("deny", "9.9.9.9"));
    expect(once.rules[0]).toEqual({ action: "deny", address: "9.9.9.9" });
    expect(prependRule(once, hostRule("deny", "9.9.9.9")).rules).toHaveLength(3);
  });
  it("moves rules within bounds", () => {
    expect(moveRule(base.rules, 0, 1).map((r) => r.pool)).toEqual(["b", "a"]);
    expect(moveRule(base.rules, 0, -1)).toBe(base.rules);
    expect(moveRule(base.rules, 1, 1)).toBe(base.rules);
  });
});

const view = (id: string, name: string, state: "running" | "stopped", noPlay = false): AgentView => ({ service: { id, name, noPlay } as never, status: { state } as never });

describe("playlist", () => {
  const views = [view("a", "Deportes HD", "running"), view("b", "Parado", "stopped"), view("c", "Oculto", "running", true), view("d", "Cine\nSecreto", "running")];

  it("lists running, visible services with the token", () => {
    const entries = agentPlayEntries("http://10.0.0.2:9980/", views, "tok123");
    expect(entries.map((e) => e.id)).toEqual(["a", "d"]);
    expect(entries[0]!.url).toBe("http://10.0.0.2:9980/play/a?token=tok123");
    expect(agentPlayEntries("http://h", views, "")[0]!.url).toBe("http://h/play/a");
  });

  it("renders an M3U with each entry on two lines and names on one line", () => {
    const text = renderM3u(agentPlayEntries("http://h", views, ""));
    expect(text).toBe('#EXTM3U\n#EXTINF:-1 tvg-id="a" group-title="Nodo",Deportes HD\nhttp://h/play/a\n#EXTINF:-1 tvg-id="d" group-title="Nodo",Cine Secreto\nhttp://h/play/d\n');
  });

  it("encodes ids and tokens in URLs", () => {
    expect(agentPlayEntries("http://h", [view("a b", "X", "running")], "t&k")[0]!.url).toBe("http://h/play/a%20b?token=t%26k");
    expect(agentPlaylistUrl("http://h:9980/", "abc")).toBe("http://h:9980/play/playlist.m3u?token=abc");
    expect(agentPlaylistUrl("http://h:9980", "")).toBe("http://h:9980/play/playlist.m3u");
  });

  it("an empty list is still a valid playlist", () => {
    expect(renderM3u([])).toBe("#EXTM3U\n");
  });
});
