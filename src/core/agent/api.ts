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
  /** Long-lived API token (integrations); optional when `credentials` are given. */
  token?: string;
  /** Username and password of the agent: the client logs in when needed and renews the session on 401. */
  credentials?: { username: string; password: string };
  transport?: Transport;
  timeoutMs?: number;
  /** For tests; defaults to the protocol of the page. */
  pageProtocol?: string;
}

export interface AgentAuthStatus {
  agent: true;
  version: string;
  /** False on an agent that only knows the API token. */
  accounts: boolean;
  /** True until the first account is created. */
  setup: boolean;
}

export interface AgentClient {
  /** Public: tells whether the agent needs its first account. Throws when the address is not an agent. */
  authStatus(): Promise<AgentAuthStatus>;
  /** Creates the first account; needs the API token. Returns whether it worked, throws AgentError otherwise. */
  setup(username: string, password: string): Promise<void>;
  /** Logs in and returns nothing; throws AgentError(401) on wrong credentials, 429 when rate limited. */
  login(): Promise<void>;
  changePassword(current: string, next: string): Promise<void>;
  info(): Promise<AgentInfo>;
  list(): Promise<AgentView[]>;
  create(service: Omit<AgentService, "id"> & { id?: string }): Promise<AgentView>;
  update(service: AgentService): Promise<AgentView>;
  remove(id: string): Promise<void>;
  setEnabled(id: string, enabled: boolean): Promise<AgentView>;
  switchInput(id: string, input: number): Promise<AgentView>;
}

const enc = encodeURIComponent;

/** Sessions kept in memory only, so recreating a client does not log in again. */
const sessionCache = new Map<string, string>();
const cacheKey = (base: string, creds?: { username: string; password: string }) => `${base}\n${creds?.username ?? ""}\n${creds?.password ?? ""}`;

export function createAgentClient(options: AgentClientOptions): AgentClient {
  const base = options.baseUrl.replace(/\/+$/, "");

  let session = sessionCache.get(cacheKey(base, options.credentials)) ?? "";

  async function send<T>(method: "GET" | "POST" | "PUT" | "DELETE", path: string, body: unknown, bearer: string): Promise<T> {
    if (isMixedContentBlocked(base, options.pageProtocol)) {
      throw new AgentError(MIXED_CONTENT, "mixed content", null);
    }
    let response;
    try {
      response = await (options.transport ?? getTransport())({
        url: `${base}${path}`,
        method,
        headers: bearer ? { Authorization: `Bearer ${bearer}` } : {},
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

  async function startSession(): Promise<void> {
    const creds = options.credentials;
    if (!creds) throw new AgentError(401, "no credentials", null);
    const reply = await send<{ token: string }>("POST", "/api/v1/auth/login", creds, "");
    session = reply.token;
    sessionCache.set(cacheKey(base, creds), session);
  }

  /** Authenticated call: session first, the API token as the alternative; one re-login on 401. */
  async function call<T>(method: "GET" | "POST" | "PUT" | "DELETE", path: string, body?: unknown): Promise<T> {
    const useSession = Boolean(options.credentials) && !options.token;
    if (useSession && !session) await startSession();
    try {
      return await send<T>(method, path, body, useSession ? session : (options.token ?? ""));
    } catch (error) {
      if (!(useSession && error instanceof AgentError && error.status === 401)) throw error;
      await startSession(); // the session expired or the password changed elsewhere
      return send<T>(method, path, body, session);
    }
  }

  return {
    authStatus: () => send<AgentAuthStatus>("GET", "/api/v1/auth/status", undefined, ""),
    setup: async (username, password) => {
      const reply = await send<{ token: string }>("POST", "/api/v1/auth/setup", { username, password }, options.token ?? "");
      session = reply.token;
      sessionCache.set(cacheKey(base, { username, password }), session);
    },
    login: startSession,
    changePassword: async (current, next) => {
      if (!session) await startSession();
      const reply = await send<{ token: string }>("POST", "/api/v1/auth/password", { current, new: next }, session);
      session = reply.token;
      if (options.credentials) sessionCache.set(cacheKey(base, options.credentials), session);
    },
    info: () => call<AgentInfo>("GET", "/api/v1/info"),
    list: () => call<AgentView[]>("GET", "/api/v1/services"),
    create: (service) => call<AgentView>("POST", "/api/v1/services", service),
    update: (service) => call<AgentView>("PUT", `/api/v1/services/${enc(service.id)}`, service),
    remove: async (id) => void (await call("DELETE", `/api/v1/services/${enc(id)}`)),
    setEnabled: (id, enabled) => call<AgentView>("POST", `/api/v1/services/${enc(id)}/${enabled ? "enable" : "disable"}`),
    switchInput: (id, input) => call<AgentView>("POST", `/api/v1/services/${enc(id)}/switch`, { input }),
  };
}
