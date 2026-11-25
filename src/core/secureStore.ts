import type { KdfParams, VaultMeta } from "./vault";
import { isEncrypted } from "./vaultFormat";

/**
 * The crypto code (argon2, AES) is large, so it loads on first use. Everything
 * that needs it either is async or runs only after the vault was unlocked,
 * which already loaded it.
 */
type VaultModule = typeof import("./vault");
const loadVault = (): Promise<VaultModule> => import("./vault");

export interface BackingStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const META_KEY = "nodo:auth";
const SKIPPED_KEY = "nodo:auth-skipped";
const ATTEMPTS_KEY = "nodo:auth-attempts";

/** Wait after the Nth consecutive failure: 1 s, 2 s, 4 s … capped at 30 s. */
export function backoffMs(failures: number): number {
  return failures <= 0 ? 0 : Math.min(30_000, 1000 * 2 ** (failures - 1));
}

/**
 * Stores values encrypted with the vault key while protection is on.
 *
 * - Protected values are written encrypted and read back only when unlocked;
 *   while locked, reads return null and writes are dropped, so an empty
 *   in-memory state can never overwrite the encrypted data.
 * - Implements zustand's `StateStorage`, so it plugs into `persist`.
 * - The key lives in memory only: a reload locks the panel again.
 */
export class SecureStore {
  private key: Uint8Array | null = null;
  private vault: VaultModule | null = null;

  constructor(
    private readonly backing: BackingStorage,
    /** Storage names that hold secrets and follow the vault. */
    private readonly protectedNames: readonly string[],
    private readonly kdf?: KdfParams,
    private readonly now: () => number = Date.now,
  ) {}

  // ---- state ----

  get meta(): VaultMeta | null {
    const raw = this.backing.getItem(META_KEY);
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as VaultMeta;
      return parsed?.version === 1 && parsed.verifier ? parsed : null;
    } catch {
      return null;
    }
  }

  get enabled(): boolean {
    return this.meta !== null;
  }

  get unlocked(): boolean {
    return this.key !== null;
  }

  /** The user chose "not now" on the first-run screen. */
  get skipped(): boolean {
    return this.backing.getItem(SKIPPED_KEY) === "1";
  }

  setSkipped(value: boolean): void {
    if (value) this.backing.setItem(SKIPPED_KEY, "1");
    else this.backing.removeItem(SKIPPED_KEY);
  }

  // ---- zustand StateStorage ----

  getItem = (name: string): string | null => {
    const raw = this.backing.getItem(name);
    if (raw === null || !isEncrypted(raw)) return raw;
    if (!this.key || !this.vault) return null;
    try {
      return this.vault.decryptValue(this.key, name, raw);
    } catch {
      return null;
    }
  };

  setItem = (name: string, value: string): void => {
    if (!this.protectedNames.includes(name) || !this.enabled) return this.backing.setItem(name, value);
    if (!this.key || !this.vault) return; // locked: drop the write
    this.backing.setItem(name, this.vault.encryptValue(this.key, name, value));
  };

  removeItem = (name: string): void => this.backing.removeItem(name);

  // ---- operations ----

  /** Turns protection on (or replaces the account) and encrypts the protected values. */
  async enable(username: string, password: string): Promise<void> {
    const vault = (this.vault = await loadVault());
    const plain = this.readAllPlain();
    const { meta, key } = await vault.createVault(username, password, this.kdf ?? vault.DEFAULT_KDF);
    this.backing.setItem(META_KEY, JSON.stringify(meta));
    this.key = key;
    this.writeAll(plain);
    this.setSkipped(false);
    this.clearFailures();
  }

  /** Verifies the credentials and keeps the key in memory. Counts failures for the back-off. */
  async unlock(username: string, password: string): Promise<boolean> {
    const meta = this.meta;
    if (!meta) return false;
    const vault = await loadVault();
    const key = await vault.unlockVault(meta, username, password);
    if (!key) {
      this.recordFailure();
      return false;
    }
    this.vault = vault;
    this.key = key;
    this.clearFailures();
    return true;
  }

  lock(): void {
    this.key = null;
  }

  /** Turns protection off after checking the password; the protected values go back to clear text. */
  async disable(password: string): Promise<boolean> {
    const meta = this.meta;
    if (!meta || !(await (await loadVault()).unlockVault(meta, meta.username, password))) return false;
    const plain = this.readAllPlain();
    this.backing.removeItem(META_KEY);
    this.key = null;
    this.writeAllPlain(plain);
    this.setSkipped(true);
    this.clearFailures();
    return true;
  }

  /** Replaces username and password; re-encrypts everything with the new key. */
  async change(currentPassword: string, username: string, password: string): Promise<boolean> {
    const meta = this.meta;
    if (!meta || !(await (await loadVault()).unlockVault(meta, meta.username, currentPassword))) return false;
    await this.enable(username, password);
    return true;
  }

  /** "I forgot my password": the encrypted data cannot be recovered, so it is deleted. */
  wipe(): void {
    for (const name of this.protectedNames) this.backing.removeItem(name);
    this.backing.removeItem(META_KEY);
    this.backing.removeItem(SKIPPED_KEY);
    this.key = null;
    this.clearFailures();
  }

  // ---- failed-attempt back-off ----

  private attempts(): { count: number; until: number } {
    try {
      const parsed = JSON.parse(this.backing.getItem(ATTEMPTS_KEY) ?? "null") as { count?: number; until?: number } | null;
      return { count: parsed?.count ?? 0, until: parsed?.until ?? 0 };
    } catch {
      return { count: 0, until: 0 };
    }
  }

  private recordFailure(): void {
    const count = this.attempts().count + 1;
    this.backing.setItem(ATTEMPTS_KEY, JSON.stringify({ count, until: this.now() + backoffMs(count) }));
  }

  private clearFailures(): void {
    this.backing.removeItem(ATTEMPTS_KEY);
  }

  /** Milliseconds until another attempt is allowed. Persisted, so a reload does not skip the wait. */
  waitMs(): number {
    return Math.max(0, this.attempts().until - this.now());
  }

  // ---- helpers ----

  /** Current values of the protected names, decrypted with the key in use (if any). */
  private readAllPlain(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const name of this.protectedNames) {
      const value = this.getItem(name);
      if (value !== null) out[name] = value;
    }
    return out;
  }

  private writeAll(values: Record<string, string>): void {
    for (const [name, value] of Object.entries(values)) this.setItem(name, value);
  }

  private writeAllPlain(values: Record<string, string>): void {
    for (const [name, value] of Object.entries(values)) this.backing.setItem(name, value);
  }
}
