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

describe("agent client with username and password", () => {
  const creds = { username: "admin", password: "correct horse" };

  function agent(sessionToken: () => string) {
    const calls: HttpRequest[] = [];
    let valid = "";
    const transport: Transport = async (r) => {
      calls.push(r);
      const path = new URL(r.url).pathname;
      if (path === "/api/v1/auth/login") return { status: 200, ok: true, data: { token: (valid = sessionToken()) } };
      if (r.headers?.Authorization !== `Bearer ${valid}`) return { status: 401, ok: false, data: { error: "no" } };
      return { status: 200, ok: true, data: [] };
    };
    return { calls, rotate: () => { valid = "rotated"; }, make: (url = "http://10.9.9.9:9980") => createAgentClient({ baseUrl: url, credentials: creds, transport, pageProtocol: "http:" }) };
  }

  it("logs in once, then reuses the session across clients", async () => {
    const { calls, make } = agent(() => "s1");
    await make().list();
    await make().list();
    expect(calls.filter((c) => c.url.endsWith("/auth/login"))).toHaveLength(1);
    expect(calls[0]?.body).toEqual(creds);
    expect(calls[1]?.headers?.Authorization).toBe("Bearer s1");
  });

  it("logs in again when the session is rejected, and retries once", async () => {
    let n = 0;
    const { calls, rotate, make } = agent(() => `s${++n}`);
    await make("http://10.9.9.8:9980").list(); // logs in
    rotate(); // the agent no longer accepts the cached session (restart with a new secret, password change)
    expect(await make("http://10.9.9.8:9980").list()).toEqual([]);
    expect(calls.filter((c) => c.url.endsWith("/auth/login"))).toHaveLength(2);
  });

  it("gives up with 401 when the credentials are wrong", async () => {
    const transport: Transport = async () => ({ status: 401, ok: false, data: { error: "wrong username or password" } });
    const client = createAgentClient({ baseUrl: "http://10.9.9.7:9980", credentials: creds, transport, pageProtocol: "http:" });
    const error = await client.list().catch((e) => e);
    expect(error).toMatchObject({ status: 401, detail: "wrong username or password" });
  });

  it("prefers the API token when both are given", async () => {
    const calls: HttpRequest[] = [];
    const client = createAgentClient({
      baseUrl: "http://10.9.9.6:9980", token: "tok", credentials: creds, pageProtocol: "http:",
      transport: async (r) => { calls.push(r); return { status: 200, ok: true, data: [] }; },
    });
    await client.list();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.headers?.Authorization).toBe("Bearer tok");
  });

  it("asks for the status without credentials", async () => {
    const calls: HttpRequest[] = [];
    const client = createAgentClient({
      baseUrl: "http://10.9.9.5:9980", pageProtocol: "http:",
      transport: async (r) => { calls.push(r); return { status: 200, ok: true, data: { agent: true, setup: true, accounts: true, version: "1" } }; },
    });
    expect((await client.authStatus()).setup).toBe(true);
    expect(calls[0]?.headers).toEqual({});
  });
});
