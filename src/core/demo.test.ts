import { describe, expect, it } from "vitest";
import { createDemoTransport, DEMO_API_URL } from "./demo";
import { BitrateTracker } from "./mediamtx/bitrate";
import {
  addPathConf, createApiClient, deletePathConf, getInfo, getPathConf, getPathDefaults, listForwardDests, listPathConfs, listPaths, patchPathConf,
} from "./mediamtx/api";
import { detectHookKeys } from "./mediamtx/pathConf";
import { applyPlan, planTranscode, RESOLUTIONS } from "./transcode";
import { mergeChannels, normalizePath } from "./mediamtx/normalize";

describe("demo transport", () => {
  it("serves channels that merge into a realistic list", async () => {
    let t = 1_000_000_000_000;
    const client = createApiClient({ baseUrl: DEMO_API_URL, username: "", password: "", transport: createDemoTransport(() => t) });
    const channels = mergeChannels((await listPaths(client)).map(normalizePath), await listPathConfs(client));
    expect(channels.map((c) => [c.name, c.live, c.kind])).toEqual([
      ["canal63", true, "configured"],
      ["canal63_720", true, "configured"],
      ["canal65", true, "dynamic"],
      ["camara_patio", false, "configured"],
      ["prueba_hls", false, "configured"],
    ]);
    expect((await getInfo(client))?.version).toBe("v1.21.4");

    // Counters grow, so two polls give a plausible bitrate close to the configured one.
    const tracker = new BitrateTracker();
    const sample = async () =>
      new Map((await listPaths(client)).map((p) => [p.name, { bytesIn: p.inboundBytes ?? 0, bytesOut: p.outboundBytes ?? 0 }]));
    tracker.update(await sample(), t);
    t += 2000;
    const rate = tracker.update(await sample(), t).get("canal63");
    expect(rate?.inMbps).toBeGreaterThan(3);
    expect(rate?.inMbps).toBeLessThan(10);
  });
});

describe("demo transport: writable configuration", () => {
  const make = () => {
    const client = createApiClient({ baseUrl: DEMO_API_URL, username: "", password: "", transport: createDemoTransport(() => 1_000_000_000_000) });
    const names = async () => mergeChannels((await listPaths(client)).map(normalizePath), await listPathConfs(client)).map((c) => [c.name, c.live]);
    return { client, names };
  };

  it("creates, patches and deletes a path", async () => {
    const { client, names } = make();
    await addPathConf(client, "nuevo", { source: "publisher" });
    expect(await names()).toContainEqual(["nuevo", false]);
    await patchPathConf(client, "nuevo", { source: "rtsp://cam/x" });
    expect(await names()).toContainEqual(["nuevo", true]);
    expect((await getPathConf(client, "nuevo")).source).toBe("rtsp://cam/x");
    await deletePathConf(client, "nuevo");
    expect((await names()).map(([n]) => n)).not.toContain("nuevo");
  });

  it("answers like the real API for missing and duplicate paths", async () => {
    const { client } = make();
    await expect(getPathConf(client, "nope")).rejects.toMatchObject({ status: 404 });
    await expect(patchPathConf(client, "nope", {})).rejects.toMatchObject({ status: 404 });
    await expect(deletePathConf(client, "nope")).rejects.toMatchObject({ status: 404 });
    await expect(addPathConf(client, "canal63", {})).rejects.toMatchObject({ status: 400, detail: expect.stringContaining("already") });
  });

  it("reports the full configuration, defaults included, and the hook keys of v1.21", async () => {
    const { client } = make();
    const defaults = await getPathDefaults(client);
    expect(defaults).toHaveProperty("runOnOnline");
    expect(detectHookKeys(defaults).command).toBe("runOnOnline");
    expect(await getPathConf(client, "camara_patio")).toMatchObject({ name: "camara_patio", record: false, recordFormat: "fmp4" });
  });

  it("brings the transcode destination to life while its origin is live", async () => {
    const { client, names } = make();
    await addPathConf(client, "origen", { source: "rtsp://cam/x" });
    await addPathConf(client, "origen_480", { source: "publisher" });
    expect(await names()).toContainEqual(["origen_480", false]);
    const plan = planTranscode({
      origin: "origen", resolution: RESOLUTIONS[2]!, encoder: "libx264", rtspPort: 8554, hook: detectHookKeys(await getPathDefaults(client)),
      originConfigured: true, currentHook: "", currentHookRestart: false, destinationExists: true,
    });
    await applyPlan(client, plan.operations);
    expect(await names()).toContainEqual(["origen_480", true]);
  });

  it("lists forward destinations with their state", async () => {
    const { client } = make();
    await patchPathConf(client, "canal63", { forward: [{ dest: "rtmps://a/live2#k" }, { dest: "rtmp://fail.example/app#k" }] });
    const dests = await listForwardDests(client, "canal63");
    expect(dests.map((d) => d.state)).toEqual(["forwarding", "error"]);
    await expect(listForwardDests(client, "nope")).rejects.toMatchObject({ status: 404 });
  });
});

describe("demo transport: dynamic channels", () => {
  it("stops being dynamic once it gets its own configuration", async () => {
    const client = createApiClient({ baseUrl: DEMO_API_URL, username: "", password: "", transport: createDemoTransport(() => 1_000_000_000_000) });
    const kinds = async () => Object.fromEntries((await listPaths(client)).map(normalizePath).map((c) => [c.name, c.kind]));
    expect((await kinds()).canal65).toBe("dynamic");
    await addPathConf(client, "canal65", { source: "publisher" });
    expect((await kinds()).canal65).toBe("configured");
  });
});
