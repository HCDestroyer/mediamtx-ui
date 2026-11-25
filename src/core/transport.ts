import { createDemoAgentTransport } from "./agent/demo";
import { createDemoTransport } from "./demo";
import { getTransport, type Transport } from "./http";
import type { Server } from "./types";

let demo: Transport | null = null;
let demoAgent: Transport | null = null;

/** Transport for the agent API: demo servers talk to an in-memory agent. */
export function agentTransportFor(server: Pick<Server, "demo">): Transport {
  if (server.demo) return (demoAgent ??= createDemoAgentTransport());
  return getTransport();
}

/** Demo servers talk to an in-memory simulator; real ones use the configured transport. */
export function transportFor(server: Pick<Server, "demo">): Transport {
  if (server.demo) return (demo ??= createDemoTransport());
  return getTransport();
}
