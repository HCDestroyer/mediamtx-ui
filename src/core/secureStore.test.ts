import { beforeEach, describe, expect, it } from "vitest";
import { backoffMs, SecureStore, type BackingStorage } from "./secureStore";

const fast = { m: 64, t: 1, p: 1 };
const NAME = "nodo:servers";
const SECRET = JSON.stringify({ state: { servers: [{ name: "Casa", password: "s3cret" }] } });

function memory(): BackingStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  };
}

let backing: ReturnType<typeof memory>;
let time: number;
const make = () => new SecureStore(backing, [NAME], fast, () => time);

beforeEach(() => {
  backing = memory();
  time = 1_000_000;
});

describe("without protection", () => {
  it("stores values as they are", () => {
    const store = make();
    store.setItem(NAME, SECRET);
    expect(backing.data.get(NAME)).toBe(SECRET);
    expect(store.getItem(NAME)).toBe(SECRET);
    expect(store.enabled).toBe(false);
  });
});

describe("enabling protection", () => {
  it("encrypts values that were already stored in clear", async () => {
    const store = make();
    store.setItem(NAME, SECRET);
    await store.enable("admin", "correct horse battery");
    expect(store.enabled && store.unlocked).toBe(true);
    expect(backing.data.get(NAME)).not.toContain("s3cret");
    expect(store.getItem(NAME)).toBe(SECRET);
  });

  it("encrypts later writes", async () => {
    const store = make();
    await store.enable("admin", "correct horse battery");
    store.setItem(NAME, SECRET);
    expect(backing.data.get(NAME)).toMatch(/^enc:v1:/);
    expect(backing.data.get(NAME)).not.toContain("s3cret");
  });

  it("does not encrypt names that are not protected", async () => {
    const store = make();
    await store.enable("admin", "correct horse battery");
    store.setItem("nodo:prefs", '{"theme":"dark"}');
    expect(backing.data.get("nodo:prefs")).toBe('{"theme":"dark"}');
  });
});

describe("locked state", () => {
  async function locked() {
    const store = make();
    await store.enable("admin", "correct horse battery");
    store.setItem(NAME, SECRET);
    store.lock();
    return store;
  }

  it("hides the data and refuses to overwrite it", async () => {
    const store = await locked();
    const before = backing.data.get(NAME);
    expect(store.getItem(NAME)).toBeNull();
    store.setItem(NAME, JSON.stringify({ state: { servers: [] } }));
    expect(backing.data.get(NAME)).toBe(before);
  });

  it("a fresh instance (page reload) starts locked but knows protection is on", async () => {
    await locked();
    const reloaded = make();
    expect(reloaded.enabled).toBe(true);
    expect(reloaded.unlocked).toBe(false);
    expect(reloaded.getItem(NAME)).toBeNull();
  });

  it("unlocks with the right credentials and returns the data", async () => {
    await locked();
    const reloaded = make();
    expect(await reloaded.unlock("admin", "correct horse battery")).toBe(true);
    expect(reloaded.getItem(NAME)).toBe(SECRET);
  });
});

describe("failed attempts", () => {
  it("backs off exponentially and survives a reload", async () => {
    const store = make();
    await store.enable("admin", "correct horse battery");
    store.lock();
    expect(await store.unlock("admin", "nope")).toBe(false);
    expect(store.waitMs()).toBe(1000);
    expect(await store.unlock("admin", "nope")).toBe(false);
    expect(store.waitMs()).toBe(2000);
    expect(make().waitMs()).toBe(2000);
    time += 2500;
    expect(store.waitMs()).toBe(0);
  });

  it("clears the counter on success", async () => {
    const store = make();
    await store.enable("admin", "correct horse battery");
    store.lock();
    await store.unlock("admin", "nope");
    await store.unlock("admin", "correct horse battery");
    expect(store.waitMs()).toBe(0);
  });

  it("caps the wait at 30 s", () => {
    expect([0, 1, 2, 3, 4, 5, 6, 10].map(backoffMs)).toEqual([0, 1000, 2000, 4000, 8000, 16000, 30000, 30000]);
  });
});

describe("changing and disabling", () => {
  it("changes the credentials and re-encrypts with the new key", async () => {
    const store = make();
    await store.enable("admin", "correct horse battery");
    store.setItem(NAME, SECRET);
    const sealedBefore = backing.data.get(NAME);
    expect(await store.change("wrong", "root", "new password 123")).toBe(false);
    expect(await store.change("correct horse battery", "root", "new password 123")).toBe(true);
    expect(backing.data.get(NAME)).not.toBe(sealedBefore);
    store.lock();
    const reloaded = make();
    expect(await reloaded.unlock("admin", "correct horse battery")).toBe(false);
    expect(await reloaded.unlock("root", "new password 123")).toBe(true);
    expect(reloaded.getItem(NAME)).toBe(SECRET);
  });

  it("disables protection only with the right password and restores clear text", async () => {
    const store = make();
    await store.enable("admin", "correct horse battery");
    store.setItem(NAME, SECRET);
    expect(await store.disable("wrong")).toBe(false);
    expect(store.enabled).toBe(true);
    expect(await store.disable("correct horse battery")).toBe(true);
    expect(store.enabled).toBe(false);
    expect(backing.data.get(NAME)).toBe(SECRET);
    expect(store.skipped).toBe(true);
  });
});

describe("forgotten password", () => {
  it("deletes the protected data and the account", async () => {
    const store = make();
    await store.enable("admin", "correct horse battery");
    store.setItem(NAME, SECRET);
    store.lock();
    store.wipe();
    expect(backing.data.has(NAME)).toBe(false);
    expect(store.enabled).toBe(false);
    expect(store.skipped).toBe(false);
  });
});

describe("first run", () => {
  it("remembers that the user skipped the setup", () => {
    const store = make();
    expect(store.skipped).toBe(false);
    store.setSkipped(true);
    expect(make().skipped).toBe(true);
  });

  it("ignores a corrupted account record", () => {
    backing.setItem("nodo:auth", "{not json");
    expect(make().enabled).toBe(false);
  });
});
