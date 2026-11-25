import { createServer, type IncomingMessage, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fetchTransport } from "./http";
import { ApiError, addPathConf, createApiClient, deletePathConf, encodePathName, patchPathConf } from "./mediamtx/api";

interface Seen { method?: string; url?: string; auth?: string; type?: string; body: string }
const seen: Seen[] = [];
let server: Server;
let base = "";

async function readBody(req: IncomingMessage): Promise<string> {
  let body = "";
  for await (const chunk of req) body += chunk;
  return body;
}

beforeAll(async () => {
  server = createServer(async (req, res) => {
    seen.push({
      method: req.method, url: req.url, auth: req.headers.authorization,
      type: req.headers["content-type"], body: await readBody(req),
    });
    if (req.url?.includes("/bad")) {
      res.writeHead(400, { "Content-Type": "application/json" });
      return void res.end(JSON.stringify({ error: "path name is not valid" }));
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(req.method === "GET" ? JSON.stringify({ ok: true }) : "");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => void server.close());

const client = () => createApiClient({ baseUrl: base, username: "panel", password: "secret", transport: fetchTransport });

describe("write requests over the real fetch transport", () => {
  it("sends POST with a JSON body and Basic Auth", async () => {
    await addPathConf(client(), "canal1", { source: "publisher", record: true });
    const call = seen.at(-1)!;
    expect(call).toMatchObject({ method: "POST", url: "/v3/config/paths/add/canal1", type: "application/json" });
    expect(JSON.parse(call.body)).toEqual({ source: "publisher", record: true });
    expect(call.auth).toBe("Basic cGFuZWw6c2VjcmV0");
  });

  it("sends PATCH and DELETE", async () => {
    await patchPathConf(client(), "canal1", { maxReaders: 5 });
    expect(seen.at(-1)).toMatchObject({ method: "PATCH", url: "/v3/config/paths/patch/canal1" });
    await deletePathConf(client(), "canal1");
    expect(seen.at(-1)).toMatchObject({ method: "DELETE", url: "/v3/config/paths/delete/canal1", body: "" });
  });

  it("keeps slashes and encodes the rest of the path name", async () => {
    expect(encodePathName("cams/patio 1")).toBe("cams/patio%201");
    expect(encodePathName("~^cam(\\d+)$")).toBe("~%5Ecam(%5Cd%2B)%24");
    await addPathConf(client(), "cams/patio 1", {});
    expect(seen.at(-1)?.url).toBe("/v3/config/paths/add/cams/patio%201");
  });

  it("raises ApiError with the message of the server", async () => {
    const error = await addPathConf(client(), "bad", {}).catch((e) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 400, detail: "path name is not valid" });
  });
});
