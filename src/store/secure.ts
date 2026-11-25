import { SecureStore, type BackingStorage } from "../core/secureStore";

/** Storage names that hold server credentials and follow the vault. */
export const SERVERS_STORAGE_NAME = "nodo:servers";

const fallback = new Map<string, string>();
/** localStorage can be missing or throw (private windows); fall back to memory so the app still runs. */
const backing: BackingStorage = {
  getItem: (k) => {
    try { return localStorage.getItem(k); } catch { return fallback.get(k) ?? null; }
  },
  setItem: (k, v) => {
    try { localStorage.setItem(k, v); } catch { fallback.set(k, v); }
  },
  removeItem: (k) => {
    try { localStorage.removeItem(k); } catch { fallback.delete(k); }
  },
};

/** The single vault of this browser profile. */
export const secureStore = new SecureStore(backing, [SERVERS_STORAGE_NAME]);
