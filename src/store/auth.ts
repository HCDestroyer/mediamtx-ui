import { create } from "zustand";
import { secureStore } from "./secure";
import { useServers } from "./servers";

/**
 * - `setup`: first run, the user has not yet created or skipped the account
 * - `off`: protection is off
 * - `locked` / `unlocked`: protection is on
 */
export type AuthStatus = "setup" | "off" | "locked" | "unlocked";

function initialStatus(): AuthStatus {
  if (secureStore.enabled) return secureStore.unlocked ? "unlocked" : "locked";
  return secureStore.skipped ? "off" : "setup";
}

interface AuthState {
  status: AuthStatus;
  username: string;
  /** Wrong username or password on the last attempt. */
  failed: boolean;
  createAccount: (username: string, password: string) => Promise<void>;
  skipSetup: () => void;
  unlock: (username: string, password: string) => Promise<boolean>;
  lock: () => void;
  disable: (password: string) => Promise<boolean>;
  change: (currentPassword: string, username: string, password: string) => Promise<boolean>;
  /** Forgotten password: deletes the encrypted servers and the account. */
  forgot: () => void;
}

const emptyServers = () => useServers.setState({ servers: [], activeServerId: null });

export const useAuth = create<AuthState>()((set) => ({
  status: initialStatus(),
  username: secureStore.meta?.username ?? "",
  failed: false,

  createAccount: async (username, password) => {
    await secureStore.enable(username, password);
    set({ status: "unlocked", username: username.trim(), failed: false });
  },

  skipSetup: () => {
    secureStore.setSkipped(true);
    set({ status: "off" });
  },

  unlock: async (username, password) => {
    const ok = await secureStore.unlock(username, password);
    if (!ok) {
      set({ failed: true });
      return false;
    }
    await useServers.persist.rehydrate();
    set({ status: "unlocked", failed: false, username: secureStore.meta?.username ?? username });
    return true;
  },

  lock: () => {
    if (!secureStore.enabled) return;
    secureStore.lock();
    // Credentials leave memory; the store drops writes while locked, so the encrypted copy stays intact.
    emptyServers();
    set({ status: "locked", failed: false });
  },

  disable: async (password) => {
    const ok = await secureStore.disable(password);
    if (ok) set({ status: "off", username: "", failed: false });
    return ok;
  },

  change: async (currentPassword, username, password) => {
    const ok = await secureStore.change(currentPassword, username, password);
    if (ok) set({ username: username.trim() });
    return ok;
  },

  forgot: () => {
    secureStore.wipe();
    emptyServers();
    set({ status: "setup", username: "", failed: false });
  },
}));

/** Seconds the user still has to wait before the next attempt. */
export const waitSeconds = (): number => Math.ceil(secureStore.waitMs() / 1000);
