import { describe, expect, it } from "vitest";
import { ApiError, type ApiClient } from "./api";
import { kickConnection, listConnections, normalizeConnection, rolesFromPaths, roleOf } from "./connections";

const noRoles = { publishers: new Set<string>(), readers: new Set<string>() };

describe("normalizeConnection", () => {
  it("reads the v1.21 byte counters and falls back to the deprecated names", () => {
    const current = normalizeConnection("rtmp", { id: "a", inboundBytes: 10, outboundBytes: 20, created: "2026-01-01T00:00:00Z" }, noRoles);
    expect([current.inBytes, current.outBytes, current.created]).toEqual([10, 20, Date.parse("2026-01-01T00:00:00Z")]);
    const old = normalizeConnection("rtmp", { id: "a", bytesReceived: 5, bytesSent: 6 }, noRoles);
    expect([old.inBytes, old.outBytes]).toEqual([5, 6]);
  });

  it("survives missing and wrong-typed fields", () => {
    const c = normalizeConnection("hls", { id: 7, path: null, created: "garbage", remoteAddr: undefined }, noRoles);
    expect(c).toMatchObject({ id: "", path: "", remoteAddr: "", user: "", created: 0, inBytes: 0, outBytes: 0 });
  });

  it("computes SRT quality and keeps the RTSP transport", () => {
    const srt = normalizeConnection("srt", { id: "s", msRTT: 12.5, packetsReceived: 990, packetsReceivedLoss: 10 }, noRoles);
    expect(srt.rttMs).toBe(12.5);
    expect(srt.lossPct).toBeCloseTo(1, 5);
    expect(normalizeConnection("srt", { id: "s" }, noRoles).lossPct).toBeUndefined();
    expect(normalizeConnection("rtsp", { id: "r", transport: "tcp" }, noRoles).transport).toBe("tcp");
    expect(normalizeConnection("rtmp", { id: "r", transport: "tcp" }, noRoles).transport).toBeUndefined();
  });
});

describe("roles", () => {
  const paths = [
    { name: "a", source: { type: "rtmpConn", id: "pub1" }, readers: [{ type: "rtspSession", id: "rd1" }, { type: "hlsSession", id: "rd2" }] },
    { name: "b", source: { type: "srtSource", id: "srt://x" }, readers: [] },
  ] as never;

  it("uses the paths list when it knows the connection", () => {
    const roles = rolesFromPaths(paths);
    expect(roleOf("pub1", 0, 999, roles)).toBe("publisher");
    expect(roleOf("rd1", 999, 0, roles)).toBe("reader");
  });

  it("guesses from the traffic direction otherwise", () => {
    const roles = rolesFromPaths(paths);
    expect(roleOf("unknown", 500, 10, roles)).toBe("publisher");
    expect(roleOf("unknown", 10, 500, roles)).toBe("reader");
    expect(roleOf("unknown", 0, 0, roles)).toBe("reader");
  });
});

function client(handlers: Record<string, () => unknown>): { api: ApiClient; calls: string[] } {
  const calls: string[] = [];
  const api: ApiClient = {
    get: async (path) => {
      calls.push(`GET ${path}`);
      const key = Object.keys(handlers).find((k) => path.startsWith(k));
      if (!key) throw new ApiError(404, "not found", null);
      return handlers[key]!() as never;
    },
    send: async (method, path) => {
      calls.push(`${method} ${path}`);
      return undefined as never;
    },
  };
  return { api, calls };
}

describe("listConnections", () => {
  const page = (items: unknown[]) => ({ itemCount: items.length, pageCount: 1, items });

  it("merges every protocol and tells who publishes from the paths list", async () => {
    const { api } = client({
      "/v3/paths/list": () => page([{ name: "canal65", source: { type: "rtmpConn", id: "f6" }, readers: [{ type: "hlsSession", id: "g7" }] }]),
      "/v3/rtmp/conns/list": () => page([{ id: "f6", path: "canal65", remoteAddr: "10.0.0.5:5000", inboundBytes: 100, outboundBytes: 0 }]),
      "/v3/hls/sessions/list": () => page([{ id: "g7", path: "canal65", remoteAddr: "10.0.0.9:1", outboundBytes: 900 }]),
      "/v3/rtsp/sessions/list": () => page([]),
    });
    const { connections, unavailable } = await listConnections(api);
    expect(connections.map((c) => `${c.proto}:${c.id}:${c.role}`).sort()).toEqual(["hls:g7:reader", "rtmp:f6:publisher"]);
    expect(unavailable).toEqual(expect.arrayContaining(["rtsps", "rtmps", "srt", "webrtc"]));
  });

  it("keeps working when one protocol fails and reports it", async () => {
    const { api } = client({
      "/v3/paths/list": () => page([]),
      "/v3/srt/conns/list": () => page([{ id: "x", path: "p" }]),
    });
    const { connections, unavailable } = await listConnections(api);
    expect(connections).toHaveLength(1);
    expect(unavailable).toContain("rtsp");
    expect(unavailable).not.toContain("srt");
  });

  it("surfaces bad credentials instead of showing an empty list", async () => {
    const api: ApiClient = { get: async () => { throw new ApiError(401, "unauthorized", null); }, send: async () => undefined as never };
    await expect(listConnections(api)).rejects.toMatchObject({ status: 401 });
  });

  it("follows pagination", async () => {
    let calls = 0;
    const api: ApiClient = {
      get: async (path) => {
        if (path.startsWith("/v3/srt/conns/list")) {
          calls += 1;
          const pageNo = Number(/page=(\d+)/.exec(path)![1]);
          return { pageCount: 2, items: [{ id: `s${pageNo}`, path: "p" }] } as never;
        }
        return { pageCount: 1, items: [] } as never;
      },
      send: async () => undefined as never,
    };
    const { connections } = await listConnections(api);
    expect(calls).toBe(2);
    expect(connections.filter((c) => c.proto === "srt").map((c) => c.id)).toEqual(["s0", "s1"]);
  });
});

describe("kickConnection", () => {
  it("POSTs to the kick route of the protocol with an encoded id", async () => {
    const { api, calls } = client({});
    await kickConnection(api, { proto: "rtsp", id: "a/b c" });
    await kickConnection(api, { proto: "srt", id: "x" });
    await kickConnection(api, { proto: "webrtc", id: "y" });
    expect(calls).toEqual([
      "POST /v3/rtsp/sessions/kick/a%2Fb%20c",
      "POST /v3/srt/conns/kick/x",
      "POST /v3/webrtc/sessions/kick/y",
    ]);
  });
});
