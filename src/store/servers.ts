import { create } from "zustand";
import { persist } from "zustand/middleware";
import { normalizeApiUrl } from "../core/http";
import { DEMO_API_URL } from "../core/demo";
import { newId } from "../core/serversIO";
import type { Server, ServerDraft } from "../core/types";

interface ServersState {
  servers: Server[];
  activeServerId: string | null;
  addServer: (draft: ServerDraft) => Server;
  updateServer: (id: string, draft: ServerDraft) => void;
  removeServer: (id: string) => void;
  setActiveServer: (id: string) => void;
  addServers: (servers: Server[]) => void;
  /** Adds (or selects) the demo server that runs on simulated data. */
  addDemoServer: () => void;
}

function clean(draft: ServerDraft): ServerDraft {
  return {
    ...draft,
    name: draft.name.trim(),
    username: draft.username.trim(),
    endpoints: draft.endpoints
      .map((e) => ({ ...e, apiUrl: normalizeApiUrl(e.apiUrl) }))
      .filter((e) => e.apiUrl !== ""),
  };
}

// Credentials are stored in the clear in localStorage on the web build. The
// Android build moves the password to secure storage in phase 5.
export const useServers = create<ServersState>()(
  persist(
    (set, get) => ({
      servers: [],
      activeServerId: null,
      addServer: (draft) => {
        const server: Server = { id: newId(), ...clean(draft) };
        set((state) => ({
          servers: [...state.servers, server],
          activeServerId: state.activeServerId ?? server.id,
        }));
        return server;
      },
      updateServer: (id, draft) =>
        set((state) => ({
          servers: state.servers.map((s) => (s.id === id ? { id, ...clean(draft) } : s)),
        })),
      removeServer: (id) =>
        set((state) => {
          const servers = state.servers.filter((s) => s.id !== id);
          const activeServerId =
            state.activeServerId === id ? (servers[0]?.id ?? null) : state.activeServerId;
          return { servers, activeServerId };
        }),
      setActiveServer: (id) => {
        if (get().servers.some((s) => s.id === id)) set({ activeServerId: id });
      },
      addDemoServer: () => {
        const existing = get().servers.find((s) => s.demo);
        if (existing) return set({ activeServerId: existing.id });
        const server: Server = {
          id: newId(), name: "Servidor demo", color: "#8a5cf6", username: "", password: "", demo: true,
          endpoints: [{ type: "lan", apiUrl: DEMO_API_URL }],
        };
        set((state) => ({ servers: [...state.servers, server], activeServerId: server.id }));
      },
      addServers: (incoming) =>
        set((state) => ({
          servers: [...state.servers, ...incoming],
          activeServerId: state.activeServerId ?? incoming[0]?.id ?? null,
        })),
    }),
    { name: "nodo:servers", version: 1 },
  ),
);

export function selectActiveServer(state: ServersState): Server | undefined {
  return state.servers.find((s) => s.id === state.activeServerId) ?? state.servers[0];
}
