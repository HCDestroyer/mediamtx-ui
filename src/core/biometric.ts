/**
 * Unlocking the panel with the fingerprint or face of the phone. The panel password is kept in the
 * Android Keystore (through a secure-storage plugin) and only released after the biometric prompt
 * succeeds. The password stays the master secret: the vault is still encrypted with it, and every other
 * way of unlocking keeps working.
 */

export interface BiometricBackend {
  /** Biometrics are enrolled and usable on this device. */
  available(): Promise<boolean>;
  /** Shows the system prompt; resolves false when the user cancels or fails. */
  authenticate(reason: string): Promise<boolean>;
  save(value: string): Promise<void>;
  /** Null when nothing is stored. */
  read(): Promise<string | null>;
  remove(): Promise<void>;
}

export interface Credentials {
  username: string;
  password: string;
}

export interface Biometric {
  /** Whether this device can do it at all. */
  supported(): Promise<boolean>;
  /** Whether the user turned it on (known without showing any prompt). */
  enabled(): boolean;
  /** Turns it on after a successful prompt. Returns false if the prompt failed. */
  enable(credentials: Credentials, reason: string): Promise<boolean>;
  /** Replaces the stored credentials after a password change, without prompting. No-op when off. */
  refresh(credentials: Credentials): Promise<void>;
  /** Shows the prompt and returns the credentials, or null (cancelled, not enabled, data gone). */
  unlock(reason: string): Promise<Credentials | null>;
  /** Forgets everything stored. */
  disable(): Promise<void>;
}

const FLAG = "nodo:biometric";

function flag(): boolean {
  try {
    return localStorage.getItem(FLAG) === "1";
  } catch {
    return false;
  }
}

function setFlag(on: boolean): void {
  try {
    if (on) localStorage.setItem(FLAG, "1");
    else localStorage.removeItem(FLAG);
  } catch {
    // Without storage the setting simply is not remembered.
  }
}

function parse(raw: string | null): Credentials | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<Credentials>;
    return typeof value.username === "string" && typeof value.password === "string" && value.password
      ? { username: value.username, password: value.password }
      : null;
  } catch {
    return null;
  }
}

export function createBiometric(backend: BiometricBackend): Biometric {
  return {
    supported: () => backend.available().catch(() => false),
    enabled: flag,
    async enable(credentials, reason) {
      if (!(await backend.available().catch(() => false))) return false;
      if (!(await backend.authenticate(reason).catch(() => false))) return false;
      await backend.save(JSON.stringify(credentials));
      setFlag(true);
      return true;
    },
    async refresh(credentials) {
      if (!flag()) return;
      await backend.save(JSON.stringify(credentials)).catch(() => undefined);
    },
    async unlock(reason) {
      if (!flag()) return null;
      if (!(await backend.authenticate(reason).catch(() => false))) return null;
      const stored = parse(await backend.read().catch(() => null));
      if (!stored) setFlag(false); // the Keystore entry is gone (reinstall, new fingerprint set): stop offering it
      return stored;
    },
    async disable() {
      setFlag(false);
      await backend.remove().catch(() => undefined);
    },
  };
}
