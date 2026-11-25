import { create } from "zustand";
import { persist } from "zustand/middleware";

/**
 * Servers whose running configuration was changed from the panel and not yet
 * saved to `mediamtx.yml`. MediaMTX applies API changes live but loses them on restart.
 */
interface UnsavedState {
  /** Server id → time of the first unsaved change. */
  since: Record<string, number>;
  markUnsaved: (serverId: string) => void;
  clear: (serverId: string) => void;
}

export const useUnsaved = create<UnsavedState>()(
  persist(
    (set) => ({
      since: {},
      markUnsaved: (serverId) =>
        set((state) => (state.since[serverId] ? state : { since: { ...state.since, [serverId]: Date.now() } })),
      clear: (serverId) =>
        set((state) => {
          const { [serverId]: _removed, ...rest } = state.since;
          return { since: rest };
        }),
    }),
    { name: "nodo:unsaved", version: 1 },
  ),
);
