import { beforeEach, describe, expect, it, vi } from "vitest";
import { createBiometric, type BiometricBackend } from "./biometric";

// A tiny localStorage for the flag, since tests run in node.
const store = new Map<string, string>();
beforeEach(() => {
  store.clear();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  });
});

function backend(overrides: Partial<BiometricBackend> = {}) {
  let saved: string | null = null;
  const b: BiometricBackend = {
    available: async () => true,
    authenticate: async () => true,
    save: async (v) => void (saved = v),
    read: async () => saved,
    remove: async () => void (saved = null),
    ...overrides,
  };
  return { b, saved: () => saved };
}

const creds = { username: "ana", password: "correct horse" };

describe("biometric unlock", () => {
  it("is off until enabled, and unlock returns nothing without prompting", async () => {
    const authenticate = vi.fn(async () => true);
    const { b } = backend({ authenticate });
    const bio = createBiometric(b);
    expect(bio.enabled()).toBe(false);
    expect(await bio.unlock("why")).toBeNull();
    expect(authenticate).not.toHaveBeenCalled();
  });

  it("stores the credentials only after the prompt succeeds", async () => {
    const { b, saved } = backend({ authenticate: async () => false });
    const bio = createBiometric(b);
    expect(await bio.enable(creds, "why")).toBe(false);
    expect(saved()).toBeNull();
    expect(bio.enabled()).toBe(false);
  });

  it("refuses to enable on a device without usable biometrics", async () => {
    const { b, saved } = backend({ available: async () => false });
    expect(await createBiometric(b).enable(creds, "why")).toBe(false);
    expect(saved()).toBeNull();
  });

  it("round-trips: enable, then unlock gives the credentials back", async () => {
    const { b } = backend();
    const bio = createBiometric(b);
    expect(await bio.enable(creds, "why")).toBe(true);
    expect(bio.enabled()).toBe(true);
    expect(await bio.unlock("why")).toEqual(creds);
  });

  it("a cancelled or failed prompt releases nothing", async () => {
    let allow = true;
    const { b } = backend({ authenticate: async () => allow });
    const bio = createBiometric(b);
    await bio.enable(creds, "why");
    allow = false;
    expect(await bio.unlock("why")).toBeNull();
    expect(bio.enabled()).toBe(true); // a cancel does not turn the feature off
  });

  it("stops offering itself when the stored entry is gone or corrupt", async () => {
    for (const read of [async () => null, async () => "not json", async () => JSON.stringify({ username: "a" }), async () => JSON.stringify({ username: "a", password: "" })]) {
      const { b } = backend();
      const bio = createBiometric({ ...b, read });
      await bio.enable(creds, "why");
      expect(await bio.unlock("why")).toBeNull();
      expect(bio.enabled()).toBe(false);
    }
  });

  it("refresh replaces the credentials after a password change, only when enabled", async () => {
    const { b, saved } = backend();
    const bio = createBiometric(b);
    await bio.refresh({ username: "ana", password: "ignored" });
    expect(saved()).toBeNull();
    await bio.enable(creds, "why");
    await bio.refresh({ username: "ana", password: "new password!" });
    expect(await bio.unlock("why")).toEqual({ username: "ana", password: "new password!" });
  });

  it("disable forgets the flag and the stored secret, even if the backend fails", async () => {
    const { b, saved } = backend();
    const bio = createBiometric(b);
    await bio.enable(creds, "why");
    await bio.disable();
    expect(bio.enabled()).toBe(false);
    expect(saved()).toBeNull();
    const failing = createBiometric({ ...b, remove: async () => { throw new Error("keystore"); } });
    await failing.enable(creds, "why");
    await expect(failing.disable()).resolves.toBeUndefined();
    expect(failing.enabled()).toBe(false);
  });

  it("supported() is false when the plugin throws", async () => {
    const { b } = backend({ available: async () => { throw new Error("no plugin"); } });
    expect(await createBiometric(b).supported()).toBe(false);
  });
});
