import { useMemo } from "react";
import { createAgentClient, type AgentClient } from "../core/agent/api";
import { DEMO_AGENT_TOKEN, DEMO_AGENT_URL } from "../core/agent/demo";
import { agentTransportFor } from "../core/transport";
import type { AgentConfig, Server } from "../core/types";
import { selectActiveServer, useServers } from "../store/servers";

/** Demo servers always use the built-in simulated agent. */
export function agentOf(server: Server): AgentConfig | undefined {
  return server.demo ? { url: DEMO_AGENT_URL, token: DEMO_AGENT_TOKEN } : server.agent;
}

/** Username and password win over the API token when both are set. */
export function clientFor(server: Server, agent: AgentConfig): AgentClient {
  return createAgentClient({
    baseUrl: agent.url,
    ...(agent.username
      ? { credentials: { username: agent.username, password: agent.password ?? "" } }
      : { token: agent.token }),
    transport: agentTransportFor(server),
  });
}

export interface ActiveAgent {
  server: Server | undefined;
  agent: AgentConfig | undefined;
  client: AgentClient | undefined;
}

/** The agent of the active server and a client for it; both undefined when the server has none. */
export function useActiveAgent(): ActiveAgent {
  const server = useServers(selectActiveServer);
  const agent = server ? agentOf(server) : undefined;
  const key = agent ? `${agent.url}\n${agent.token}\n${agent.username ?? ""}\n${agent.password ?? ""}` : "";
  const client = useMemo(
    () => (server && agent ? clientFor(server, agent) : undefined),
    // `key` covers every field the client depends on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [server?.id, server?.demo, key],
  );
  return { server, agent, client };
}
