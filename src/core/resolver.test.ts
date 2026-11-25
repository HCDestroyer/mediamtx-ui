import { describe, expect, it } from "vitest";
import { TransportError, type HttpRequest, type HttpResponse, type Transport } from "./http";
import { FailureCounter, orderedEndpoints, probeEndpoint, resolveEndpoint } from "./resolver";
import type { Server } from "./types";

const server: Server = {
  id: "s1",
  name: "Home",
  color: "#2b62e6",
  username: "panel",
  password: "pässword",
  endpoints: [
    { type: "public", apiUrl: "https://home.example.net" },
    { type: "lan", apiUrl: "192.168.1.20:9997/" },
    { type: "vpn", apiUrl: "http://10.8.0.2:9997" },
  ],
};

/** Builds a transport from a map of base URL → outcome. */
function fakeTransport(outcomes: Record<string, number | "timeout" | "network">) {
  const calls: HttpRequest[] = [];
  const transport: Transport = async (request) => {
    calls.push(request);
    const base = Object.keys(outcomes).find((b) => request.url.startsWith(b));
    const outcome = base ? outcomes[base] : "network";
    if (outcome === "timeout") throw new TransportError("timeout", "t");
    if (outcome === "network" || outcome === undefined) throw new TransportError("network", "n");
    const response: HttpResponse = { status: outcome, ok: outcome >= 200 && outcome < 300, data: null };
    return response;
  };
  return { transport, calls };
}

describe("orderedEndpoints", () => {
  it("sorts LAN, VPN, public and skips blank URLs", () => {
    const list = orderedEndpoints({
      endpoints: [...server.endpoints, { type: "lan", apiUrl: "  " }],
    });
    expect(list.map((e) => e.type)).toEqual(["lan", "vpn", "public"]);
  });
});

describe("probeEndpoint", () => {
  it("normalizes the URL, sends Basic Auth and measures latency", async () => {
    const { transport, calls } = fakeTransport({ "http://192.168.1.20:9997": 200 });
    let t = 100;
    const result = await probeEndpoint(server, server.endpoints[1]!, {
      transport,
      pageProtocol: "http:",
      now: () => (t += 7),
    });
    expect(result).toMatchObject({ ok: true, reachable: true, latencyMs: 7 });
    expect(calls[0]?.url).toBe("http://192.168.1.20:9997/v3/paths/list?itemsPerPage=1");
    expect(calls[0]?.headers?.Authorization).toBe(
      "Basic cGFuZWw6cMOkc3N3b3Jk",
    );
  });

  it("treats 401 as reachable but not ok", async () => {
    const { transport } = fakeTransport({ "http://192.168.1.20:9997": 401 });
    const result = await probeEndpoint(server, server.endpoints[1]!, { transport, pageProtocol: "http:" });
    expect(result).toMatchObject({ ok: false, reachable: true, failure: "auth", status: 401 });
  });

  it("reports timeouts and network errors as unreachable", async () => {
    const t1 = await probeEndpoint(server, server.endpoints[1]!, {
      transport: fakeTransport({ "http://192.168.1.20:9997": "timeout" }).transport,
      pageProtocol: "http:",
    });
    const t2 = await probeEndpoint(server, server.endpoints[1]!, {
      transport: fakeTransport({}).transport,
      pageProtocol: "http:",
    });
    expect(t1).toMatchObject({ reachable: false, failure: "timeout" });
    expect(t2).toMatchObject({ reachable: false, failure: "network" });
  });

  it("does not call an http API from an https page", async () => {
    const { transport, calls } = fakeTransport({ "http://192.168.1.20:9997": 200 });
    const result = await probeEndpoint(server, server.endpoints[1]!, { transport, pageProtocol: "https:" });
    expect(result).toMatchObject({ reachable: false, failure: "mixed-content" });
    expect(calls).toHaveLength(0);
  });
});

describe("resolveEndpoint", () => {
  it("uses LAN when it answers and does not try the rest", async () => {
    const { transport, calls } = fakeTransport({ "http://192.168.1.20:9997": 200 });
    const result = await resolveEndpoint(server, { transport, pageProtocol: "http:" });
    expect(result.active?.endpoint.type).toBe("lan");
    expect(calls).toHaveLength(1);
  });

  it("falls through LAN → VPN when LAN is down", async () => {
    const { transport } = fakeTransport({
      "http://192.168.1.20:9997": "timeout",
      "http://10.8.0.2:9997": 200,
    });
    const result = await resolveEndpoint(server, { transport, pageProtocol: "http:" });
    expect(result.active?.endpoint.type).toBe("vpn");
    expect(result.probes.map((p) => p.endpoint.type)).toEqual(["lan", "vpn"]);
  });

  it("falls through to the public endpoint last", async () => {
    const { transport } = fakeTransport({ "https://home.example.net": 200 });
    const result = await resolveEndpoint(server, { transport, pageProtocol: "http:" });
    expect(result.active?.endpoint.type).toBe("public");
    expect(result.probes).toHaveLength(3);
  });

  it("stops at a reachable endpoint even with bad credentials", async () => {
    const { transport, calls } = fakeTransport({ "http://192.168.1.20:9997": 401 });
    const result = await resolveEndpoint(server, { transport, pageProtocol: "http:" });
    expect(result.active).toMatchObject({ reachable: true, ok: false, failure: "auth" });
    expect(calls).toHaveLength(1);
  });

  it("returns no active endpoint when everything is down", async () => {
    const { transport } = fakeTransport({});
    const result = await resolveEndpoint(server, { transport, pageProtocol: "http:" });
    expect(result.active).toBeNull();
    expect(result.probes).toHaveLength(3);
  });
});

describe("FailureCounter", () => {
  it("asks to re-resolve after two consecutive failures", () => {
    const counter = new FailureCounter();
    expect(counter.record(false)).toBe(false);
    expect(counter.record(false)).toBe(true);
  });

  it("resets on success", () => {
    const counter = new FailureCounter();
    counter.record(false);
    counter.record(true);
    expect(counter.record(false)).toBe(false);
    expect(counter.count).toBe(1);
  });
});
