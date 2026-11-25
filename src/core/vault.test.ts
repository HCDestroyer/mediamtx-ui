import { describe, expect, it } from "vitest";
import { passwordStrength } from "./passwordStrength";
import { createVault, DEFAULT_KDF, decryptValue, encryptValue, isEncrypted, unlockVault } from "./vault";

// Cheap parameters keep the suite fast; production uses DEFAULT_KDF.
const fast = { m: 64, t: 1, p: 1 };

describe("vault", () => {
  it("unlocks with the right username and password", async () => {
    const { meta, key } = await createVault(" admin ", "correct horse battery", fast);
    expect(meta.username).toBe("admin");
    const unlocked = await unlockVault(meta, "admin", "correct horse battery");
    expect(unlocked).not.toBeNull();
    expect(Array.from(unlocked!)).toEqual(Array.from(key));
  });

  it("rejects a wrong password, a wrong username and an empty one", async () => {
    const { meta } = await createVault("admin", "correct horse battery", fast);
    expect(await unlockVault(meta, "admin", "wrong")).toBeNull();
    expect(await unlockVault(meta, "root", "correct horse battery")).toBeNull();
    expect(await unlockVault(meta, "admin", "")).toBeNull();
  });

  it("uses a fresh salt every time", async () => {
    const a = await createVault("u", "pw-pw-pw-pw", fast);
    const b = await createVault("u", "pw-pw-pw-pw", fast);
    expect(a.meta.salt).not.toBe(b.meta.salt);
    expect(Array.from(a.key)).not.toEqual(Array.from(b.key));
  });

  it("round-trips values and never stores them in clear", async () => {
    const { key } = await createVault("u", "pw-pw-pw-pw", fast);
    const secret = JSON.stringify({ servers: [{ password: "s3cret ñ" }] });
    const sealed = encryptValue(key, "nodo:servers", secret);
    expect(isEncrypted(sealed)).toBe(true);
    expect(sealed).not.toContain("s3cret");
    expect(decryptValue(key, "nodo:servers", sealed)).toBe(secret);
  });

  it("uses a new nonce for each encryption", async () => {
    const { key } = await createVault("u", "pw-pw-pw-pw", fast);
    expect(encryptValue(key, "x", "same")).not.toBe(encryptValue(key, "x", "same"));
  });

  it("fails to decrypt with another key, another name or tampered data", async () => {
    const a = await createVault("u", "pw-pw-pw-pw", fast);
    const b = await createVault("u", "other-other-1", fast);
    const sealed = encryptValue(a.key, "nodo:servers", "data");
    expect(() => decryptValue(b.key, "nodo:servers", sealed)).toThrow();
    expect(() => decryptValue(a.key, "nodo:prefs", sealed)).toThrow();
    const flipped = sealed.slice(0, -4) + (sealed.endsWith("AAAA") ? "BBBB" : "AAAA");
    expect(() => decryptValue(a.key, "nodo:servers", flipped)).toThrow();
  });

  it("keeps production parameters at the OWASP minimum or above", () => {
    expect(DEFAULT_KDF.m).toBeGreaterThanOrEqual(19456);
    expect(DEFAULT_KDF.t).toBeGreaterThanOrEqual(2);
  });
});

describe("passwordStrength", () => {
  it("scores by length and variety", () => {
    expect(passwordStrength("")).toBe(0);
    expect(passwordStrength("abc")).toBe(1);
    expect(passwordStrength("abcdefgh")).toBe(1);
    expect(passwordStrength("abcdefghijkl")).toBe(2);
    expect(passwordStrength("Abcdefghij12")).toBe(3);
    expect(passwordStrength("Abcdefghijkl1234!")).toBe(4);
  });
});
