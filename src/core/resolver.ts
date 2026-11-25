import {
  basicAuthHeader,
  getTransport,
  isMixedContentBlocked,
  normalizeApiUrl,
  TransportError,
  type Transport,
} from "./http";
import { ENDPOINT_ORDER, type Endpoint, type Server } from "./types";

/** Cheap call used to check that an endpoint is alive. */
export const HEALTH_PATH = "/v3/paths/list?itemsPerPage=1";
/** Consecutive failures on the active endpoint before re-resolving. */
export const FAILURES_BEFORE_RESOLVE = 2;
export const PROBE_TIMEOUT_MS = 2500;

export type ProbeFailure =
  | "timeout"
  | "network"
  | "mixed-content"
  | "auth"
  | "http";

export interface ProbeResult {
  endpoint: Endpoint;
  /** The API answered with a success status. */
  ok: boolean;
  /**
   * The host answered, even if with an error. The resolver stops at the first
   * reachable endpoint: if the credentials are wrong on LAN they are wrong on
   * VPN too, so trying the next one would not help.
   */
  reachable: boolean;
  latencyMs?: number;
  status?: number;
  failure?: ProbeFailure;
}

export interface ProbeOptions {
  transport?: Transport;
  timeoutMs?: number;
  /** Injectable for tests. */
  now?: () => number;
  pageProtocol?: string;
}

export async function probeEndpoint(
  server: Pick<Server, "username" | "password">,
  endpoint: Endpoint,
  options: ProbeOptions = {},
): Promise<ProbeResult> {
  const apiUrl = normalizeApiUrl(endpoint.apiUrl);
  const normalized: Endpoint = { ...endpoint, apiUrl };
  if (isMixedContentBlocked(apiUrl, options.pageProtocol)) {
    return { endpoint: normalized, ok: false, reachable: false, failure: "mixed-content" };
  }
  const transport = options.transport ?? getTransport();
  const now = options.now ?? (() => performance.now());
  const started = now();
  try {
    const response = await transport({
      url: `${apiUrl}${HEALTH_PATH}`,
      headers: { Authorization: basicAuthHeader(server.username, server.password) },
      timeoutMs: options.timeoutMs ?? PROBE_TIMEOUT_MS,
    });
    const latencyMs = Math.max(0, Math.round(now() - started));
    if (response.ok) {
      return { endpoint: normalized, ok: true, reachable: true, latencyMs, status: response.status };
    }
    const failure: ProbeFailure =
      response.status === 401 || response.status === 403 ? "auth" : "http";
    return { endpoint: normalized, ok: false, reachable: true, latencyMs, status: response.status, failure };
  } catch (error) {
    const failure: ProbeFailure =
      error instanceof TransportError && error.kind === "timeout" ? "timeout" : "network";
    return { endpoint: normalized, ok: false, reachable: false, failure };
  }
}

export interface ResolveResult {
  /** The first reachable endpoint, or null if none answered. */
  active: ProbeResult | null;
  /** Every endpoint that was tried, in order. */
  probes: ProbeResult[];
}

/** Endpoints sorted LAN → VPN → public; blank URLs are skipped. */
export function orderedEndpoints(server: Pick<Server, "endpoints">): Endpoint[] {
  return ENDPOINT_ORDER.flatMap((type) =>
    server.endpoints.filter((e) => e.type === type && e.apiUrl.trim() !== ""),
  );
}

/** Tries the endpoints in order and stops at the first one that answers. */
export async function resolveEndpoint(
  server: Pick<Server, "endpoints" | "username" | "password">,
  options: ProbeOptions & { onProbe?: (result: ProbeResult) => void } = {},
): Promise<ResolveResult> {
  const probes: ProbeResult[] = [];
  for (const endpoint of orderedEndpoints(server)) {
    const result = await probeEndpoint(server, endpoint, options);
    probes.push(result);
    options.onProbe?.(result);
    if (result.reachable) return { active: result, probes };
  }
  return { active: null, probes };
}

/** Probes every endpoint in parallel, for the "test connection" action. */
export async function probeAll(
  server: Pick<Server, "endpoints" | "username" | "password">,
  options: ProbeOptions = {},
): Promise<ProbeResult[]> {
  return Promise.all(orderedEndpoints(server).map((endpoint) => probeEndpoint(server, endpoint, options)));
}

/** Tracks consecutive failures of the active endpoint. */
export class FailureCounter {
  private failures = 0;

  get count(): number {
    return this.failures;
  }

  /** Records a probe outcome; returns true when the endpoint must be re-resolved. */
  record(ok: boolean): boolean {
    if (ok) {
      this.failures = 0;
      return false;
    }
    this.failures += 1;
    return this.failures >= FAILURES_BEFORE_RESOLVE;
  }

  reset(): void {
    this.failures = 0;
  }
}
