import { describe, expect, it } from "vitest";
import { isMixedContentBlocked, isValidApiUrl, normalizeApiUrl } from "./http";
import { exportServers, parseImport } from "./serversIO";
import type { Server } from "./types";

const sample: Server = {
  id: "a",
  name: "Home",
  color: "#2b62e6",
  username: "panel",
  password: "secret",
  endpoints: [{ type: "lan", apiUrl: "http://192.168.1.20:9997" }],
};

describe("normalizeApiUrl", () => {
  it("adds the scheme and strips trailing slashes", () => {
    expect(normalizeApiUrl(" 192.168.1.20:9997/ ")).toBe("http://192.168.1.20:9997");
    expect(normalizeApiUrl("https://x.example.net//")).toBe("https://x.example.net");
    expect(normalizeApiUrl("   ")).toBe("");
  });

  it("validates hosts and protocols", () => {
    expect(isValidApiUrl("10.0.0.1:9997")).toBe(true);
    expect(isValidApiUrl("ftp://10.0.0.1")).toBe(false);
    expect(isValidApiUrl("")).toBe(false);
  });

  it("detects mixed content", () => {
    expect(isMixedContentBlocked("http://10.0.0.1:9997", "https:")).toBe(true);
    expect(isMixedContentBlocked("https://x.example.net", "https:")).toBe(false);
    expect(isMixedContentBlocked("http://10.0.0.1:9997", "http:")).toBe(false);
  });
});

describe("servers export / import", () => {
  it("omits passwords unless asked", () => {
    expect(JSON.parse(exportServers([sample], false)).servers[0]).not.toHaveProperty("password");
    expect(JSON.parse(exportServers([sample], true)).servers[0].password).toBe("secret");
  });

  it("round-trips a server", () => {
    const { servers, warnings } = parseImport(exportServers([sample], true));
    expect(warnings).toEqual([]);
    expect(servers).toEqual([sample]);
  });

  it("regenerates ids that already exist", () => {
    const { servers } = parseImport(exportServers([sample], false), new Set(["a"]));
    expect(servers[0]?.id).not.toBe("a");
    expect(servers[0]?.password).toBe("");
  });

  it("skips invalid entries and reports them", () => {
    const text = JSON.stringify({
      format: "mediamtx-panel/servers",
      version: 1,
      servers: [{ name: "" }, { name: "NoEndpoints", endpoints: [] }, { name: "Ok", endpoints: [{ type: "vpn", apiUrl: "10.8.0.2:9997" }] }],
    });
    const { servers, warnings } = parseImport(text);
    expect(servers.map((s) => s.name)).toEqual(["Ok"]);
    expect(servers[0]?.endpoints[0]?.apiUrl).toBe("http://10.8.0.2:9997");
    expect(warnings).toHaveLength(2);
  });

  it("rejects files that are not exports", () => {
    expect(() => parseImport("nope")).toThrow("invalid-json");
    expect(() => parseImport(JSON.stringify({ hello: 1 }))).toThrow("invalid-format");
  });
});
