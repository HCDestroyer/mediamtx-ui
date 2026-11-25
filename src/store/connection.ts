import { create } from "zustand";
import {
  FailureCounter,
  probeAll,
  probeEndpoint,
  resolveEndpoint,
  type ProbeResult,
} from "../core/resolver";
import type { Server } from "../core/types";

export type ConnectionStatus =
  | "idle"
  | "resolving"
  | "online"
  | "auth-error"
  | "offline";

export interface Connection {
  status: ConnectionStatus;
  /** Endpoint currently in use, with its last measured latency. */
  active: ProbeResult | null;
  /** Result of the last full resolution, in the order tried. */
  probes: ProbeResult[];
  checkedAt: number | null;
}

const EMPTY: Connection = { status: "idle", active: null, probes: [], checkedAt: null };

/** How often the active endpoint is re-checked. */
export const HEALTH_INTERVAL_MS = 15_000;

interface ConnectionState {
  byServer: Record<string, Connection>;
  /** Result of the last manual "test connection", per server. */
  tests: Record<string, ProbeResult[]>;
  testing: Record<string, boolean>;
  connect: (server: Server) => Promise<void>;
  disconnect: (serverId: string) => void;
  test: (server: Server) => Promise<ProbeResult[]>;
}

interface Runtime {
  timer: ReturnType<typeof setInterval> | null;
  failures: FailureCounter;
  /** Incremented on every connect/disconnect so stale async work is ignored. */
  generation: number;
}

const runtimes = new Map<string, Runtime>();

function runtimeFor(serverId: string): Runtime {
  let runtime = runtimes.get(serverId);
  if (!runtime) {
    runtime = { timer: null, failures: new FailureCounter(), generation: 0 };
    runtimes.set(serverId, runtime);
  }
  return runtime;
}

export const useConnection = create<ConnectionState>()((set, get) => {
  const patch = (serverId: string, value: Partial<Connection>) =>
    set((state) => ({
      byServer: {
        ...state.byServer,
        [serverId]: { ...(state.byServer[serverId] ?? EMPTY), ...value },
      },
    }));

  const stopTimer = (runtime: Runtime) => {
    if (runtime.timer) clearInterval(runtime.timer);
    runtime.timer = null;
  };

  const connect = async (server: Server): Promise<void> => {
    const runtime = runtimeFor(server.id);
    stopTimer(runtime);
    const generation = ++runtime.generation;
    runtime.failures.reset();

    // Keep showing the previous endpoint while re-resolving.
    const previous = get().byServer[server.id];
    patch(server.id, { status: previous?.active ? previous.status : "resolving" });

    const { active, probes } = await resolveEndpoint(server);
    if (generation !== runtime.generation) return;

    patch(server.id, {
      status: !active ? "offline" : active.ok ? "online" : "auth-error",
      active,
      probes,
      checkedAt: Date.now(),
    });

    runtime.timer = setInterval(async () => {
      const current = get().byServer[server.id]?.active;
      if (!current) return void connect(server);
      const result = await probeEndpoint(server, current.endpoint);
      if (generation !== runtime.generation) return;
      const mustResolve = runtime.failures.record(result.reachable);
      if (mustResolve) return void connect(server);
      patch(server.id, {
        status: result.ok ? "online" : result.reachable ? "auth-error" : (get().byServer[server.id]?.status ?? "offline"),
        active: result.reachable ? result : current,
        checkedAt: Date.now(),
      });
    }, HEALTH_INTERVAL_MS);
  };

  return {
    byServer: {},
    tests: {},
    testing: {},
    connect,
    disconnect: (serverId) => {
      const runtime = runtimeFor(serverId);
      runtime.generation += 1;
      stopTimer(runtime);
      patch(serverId, EMPTY);
    },
    test: async (server) => {
      set((state) => ({ testing: { ...state.testing, [server.id]: true } }));
      const results = await probeAll(server);
      set((state) => ({
        tests: { ...state.tests, [server.id]: results },
        testing: { ...state.testing, [server.id]: false },
      }));
      return results;
    },
  };
});

export function connectionOf(byServer: Record<string, Connection>, serverId: string | undefined): Connection {
  return (serverId && byServer[serverId]) || EMPTY;
}
