import { describe, expect, it } from "vitest";
import type { ApiClient } from "./api";
import { mirrorWrites, type PathMirror } from "./mirror";

function fixture(options: { failApi?: boolean; failMirror?: boolean } = {}) {
  const calls: string[] = [];
  const inner: ApiClient = {
    get: async () => ({}) as never,
    send: async (method, path) => {
      calls.push(`api ${method} ${path}`);
      if (options.failApi) throw new Error("api down");
      return undefined as never;
    },
  };
  const step = (name: string) => async (...args: unknown[]) => {
    calls.push(`mirror ${name} ${JSON.stringify(args)}`);
    if (options.failMirror) throw new Error("agent down");
  };
  const mirror: PathMirror = { set: step("set"), patch: step("patch"), remove: step("remove") };
  return { calls, inner, mirror };
}

describe("mirrorWrites", () => {
  it("repeats add, patch and delete in the additional file, after the live change", async () => {
    const { calls, inner, mirror } = fixture();
    const m = mirrorWrites(inner, mirror);
    await m.client.send("POST", "/v3/config/paths/add/cams/patio", { source: "publisher" });
    await m.client.send("PATCH", "/v3/config/paths/patch/canal%2063", { maxReaders: 2 });
    await m.client.send("DELETE", "/v3/config/paths/delete/cams/patio");
    expect(calls).toEqual([
      "api POST /v3/config/paths/add/cams/patio",
      'mirror set ["cams/patio",{"source":"publisher"}]',
      "api PATCH /v3/config/paths/patch/canal%2063",
      'mirror patch ["canal 63",{"maxReaders":2}]',
      "api DELETE /v3/config/paths/delete/cams/patio",
      'mirror remove ["cams/patio"]',
    ]);
    expect(m.take()).toEqual({ writes: 3, mirrored: true });
    expect(m.take()).toEqual({ writes: 0, mirrored: false });
  });

  it("does not mirror when the live change failed", async () => {
    const { calls, inner, mirror } = fixture({ failApi: true });
    const m = mirrorWrites(inner, mirror);
    await expect(m.client.send("POST", "/v3/config/paths/add/x", {})).rejects.toThrow("api down");
    expect(calls.some((c) => c.startsWith("mirror"))).toBe(false);
    expect(m.take().writes).toBe(0);
  });

  it("keeps the live change and reports it as not persisted when the agent fails", async () => {
    const { inner, mirror } = fixture({ failMirror: true });
    const errors: unknown[] = [];
    const m = mirrorWrites(inner, mirror, (e) => errors.push(e));
    await expect(m.client.send("POST", "/v3/config/paths/add/x", {})).resolves.toBeUndefined();
    expect(errors).toHaveLength(1);
    expect(m.take()).toEqual({ writes: 1, mirrored: false });
  });

  it("is not persisted when there is no agent", async () => {
    const { inner } = fixture();
    const m = mirrorWrites(inner, undefined);
    await m.client.send("POST", "/v3/config/paths/add/x", {});
    expect(m.take()).toEqual({ writes: 1, mirrored: false });
  });

  it("ignores writes that are not path changes", async () => {
    const { calls, inner, mirror } = fixture();
    const m = mirrorWrites(inner, mirror);
    await m.client.send("POST", "/v3/paths/kick/whatever");
    expect(calls).toEqual(["api POST /v3/paths/kick/whatever"]);
    expect(m.take().writes).toBe(0);
  });

  it("one failed mirror among several taints the whole batch", async () => {
    const calls: string[] = [];
    let n = 0;
    const inner: ApiClient = { get: async () => ({}) as never, send: async () => undefined as never };
    const mirror: PathMirror = {
      set: async () => { calls.push("set"); if (++n === 2) throw new Error("x"); },
      patch: async () => {}, remove: async () => {},
    };
    const m = mirrorWrites(inner, mirror);
    await m.client.send("POST", "/v3/config/paths/add/a", {});
    await m.client.send("POST", "/v3/config/paths/add/b", {});
    expect(m.take().mirrored).toBe(false);
  });
});
