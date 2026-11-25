import { describe, expect, it } from "vitest";
import { AgentError, createAgentClient, MIXED_CONTENT, UNREACHABLE } from "./api";
import { TransportError, type HttpRequest, type Transport } from "../http";

function fake(respond: (r: HttpRequest) => { status: number; data?: unknown } | Error) {
  const calls: HttpRequest[] = [];
  const transport: Transport = async (r) => {
    calls.push(r);
    const out = respond(r);
    if (out instanceof Error) throw out;
    return { status: out.status, ok: out.status >= 200 && out.status < 300, data: out.data ?? null };
  };
  return { calls, client: createAgentClient({ baseUrl: "http://10.0.0.5:9998/", token: "tok", transport, pageProtocol: "http:" }) };
}

describe("agent client", () => {
  it("sends the bearer token and uses the right verbs and paths", async () => {
    const { client, calls } = fake(() => ({ status: 200, data: [] }));
    await client.list();
    await client.setEnabled("deportes hd", true);
    await client.setEnabled("deportes hd", false);
    await client.switchInput("a", 1);
    await client.update({ id: "a" } as never);
    await client.create({ name: "x" } as never);
    await client.remove("a");
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      "GET http://10.0.0.5:9998/api/v1/services",
      "POST http://10.0.0.5:9998/api/v1/services/deportes%20hd/enable",
      "POST http://10.0.0.5:9998/api/v1/services/deportes%20hd/disable",
      "POST http://10.0.0.5:9998/api/v1/services/a/switch",
      "PUT http://10.0.0.5:9998/api/v1/services/a",
      "POST http://10.0.0.5:9998/api/v1/services",
      "DELETE http://10.0.0.5:9998/api/v1/services/a",
    ]);
    expect(calls.every((c) => c.headers?.Authorization === "Bearer tok")).toBe(true);
    expect(calls[3]?.body).toEqual({ input: 1 });
  });

  it("surfaces the message of the agent", async () => {
    const { client } = fake(() => ({ status: 400, data: { error: "input 1: address must look like type://address" } }));
    const error = await client.create({ name: "x" } as never).catch((e) => e);
    expect(error).toBeInstanceOf(AgentError);
    expect(error).toMatchObject({ status: 400, detail: "input 1: address must look like type://address" });
  });

  it("tells a bad token apart from an unreachable agent", async () => {
    const bad = await fake(() => ({ status: 401, data: { error: "missing or wrong token" } })).client.list().catch((e) => e);
    expect(bad.status).toBe(401);
    const down = await fake(() => new TransportError("network", "refused")).client.list().catch((e) => e);
    expect(down.status).toBe(UNREACHABLE);
  });

  it("does not call an http agent from an https page", async () => {
    const calls: HttpRequest[] = [];
    const client = createAgentClient({
      baseUrl: "http://10.0.0.5:9998", token: "t", pageProtocol: "https:",
      transport: async (r) => { calls.push(r); return { status: 200, ok: true, data: [] }; },
    });
    const error = await client.list().catch((e) => e);
    expect(error.status).toBe(MIXED_CONTENT);
    expect(calls).toHaveLength(0);
  });
});
