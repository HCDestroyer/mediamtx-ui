#!/usr/bin/env node
/**
 * Minimal stand-in for the MediaMTX Control API, for developing the panel
 * without a real server. It checks Basic Auth, answers CORS preflights and
 * serves just enough of /v3 for the connection resolver.
 *
 *   node scripts/mock-mediamtx.mjs [--port 9997] [--user panel] [--pass secret] [--delay 0]
 */
import { createServer } from "node:http";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    port: { type: "string", default: "9997" },
    user: { type: "string", default: "panel" },
    pass: { type: "string", default: "secret" },
    delay: { type: "string", default: "0" },
  },
});

const expected = `Basic ${Buffer.from(`${values.user}:${values.pass}`).toString("base64")}`;
const delay = Number(values.delay);

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
  "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
};

const send = (res, status, body) => {
  res.writeHead(status, { ...cors, "Content-Type": "application/json" });
  res.end(body === undefined ? "" : JSON.stringify(body));
};

createServer((req, res) => {
  setTimeout(() => {
    if (req.method === "OPTIONS") return send(res, 204);
    if (req.headers.authorization !== expected) return send(res, 401, { error: "authentication failed" });
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/v3/paths/list") {
      return send(res, 200, { itemCount: 0, pageCount: 0, items: [] });
    }
    if (url.pathname === "/v3/info") return send(res, 200, { version: "v1.21.4", started: new Date().toISOString() });
    return send(res, 404, { error: "not found" });
  }, delay);
}).listen(Number(values.port), () => {
  console.log(`mock MediaMTX API on :${values.port} (user "${values.user}")`);
});
