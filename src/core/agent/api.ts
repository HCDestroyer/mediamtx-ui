import { getTransport, isMixedContentBlocked, type Transport } from "../http";
import type { AgentInfo, AgentService, AgentView } from "./types";

export class AgentError extends Error {
  readonly status: number;
  /** Text sent by the agent, when there is one. */
  readonly detail: string | null;
  constructor(status: number, message: string, detail: string | null) {
    super(message);
    this.name = "AgentError";
    this.status = status;
    this.detail = detail;
  }
}

/** Status 0 marks a request that never reached the agent. */
export const UNREACHABLE = 0;
export const MIXED_CONTENT = -1;

export interface AgentClientOptions {
  baseUrl: string;
  token: string;
  transport?: Transport;
  timeoutMs?: number;
  /** For tests; defaults to the protocol of the page. */
  pageProtocol?: string;
}

export interface AgentClient {
  info(): Promise<AgentInfo>;
  list(): Promise<AgentView[]>;
  create(service: Omit<AgentService, "id"> & { id?: string }): Promise<AgentView>;
  update(service: AgentService): Promise<AgentView>;
  remove(id: string): Promise<void>;
  setEnabled(id: string, enabled: boolean): Promise<AgentView>;
  switchInput(id: string, input: number): Promise<AgentView>;
}

const enc = encodeURIComponent;

export function createAgentClient(options: AgentClientOptions): AgentClient {
  const base = options.baseUrl.replace(/\/+$/, "");

  async function call<T>(method: "GET" | "POST" | "PUT" | "DELETE", path: string, body?: unknown): Promise<T> {
    if (isMixedContentBlocked(base, options.pageProtocol)) {
      throw new AgentError(MIXED_CONTENT, "mixed content", null);
    }
    let response;
    try {
      response = await (options.transport ?? getTransport())({
        url: `${base}${path}`,
        method,
        headers: { Authorization: `Bearer ${options.token}` },
        body,
        timeoutMs: options.timeoutMs ?? 6000,
      });
    } catch {
      throw new AgentError(UNREACHABLE, "agent unreachable", null);
    }
    if (!response.ok) {
      const data = response.data;
      const detail =
        data && typeof data === "object" && "error" in data && typeof data.error === "string" ? data.error : null;
      throw new AgentError(response.status, `HTTP ${response.status} on ${method} ${path}`, detail);
    }
    return response.data as T;
  }

  return {
    info: () => call<AgentInfo>("GET", "/api/v1/info"),
    list: () => call<AgentView[]>("GET", "/api/v1/services"),
    create: (service) => call<AgentView>("POST", "/api/v1/services", service),
    update: (service) => call<AgentView>("PUT", `/api/v1/services/${enc(service.id)}`, service),
    remove: async (id) => void (await call("DELETE", `/api/v1/services/${enc(id)}`)),
    setEnabled: (id, enabled) => call<AgentView>("POST", `/api/v1/services/${enc(id)}/${enabled ? "enable" : "disable"}`),
    switchInput: (id, input) => call<AgentView>("POST", `/api/v1/services/${enc(id)}/switch`, { input }),
  };
}
