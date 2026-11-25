import { describe, expect, it } from "vitest";
import { createDemoTransport, DEMO_API_URL } from "./demo";
import { BitrateTracker } from "./mediamtx/bitrate";
import { createApiClient, getInfo, listPathConfs, listPaths } from "./mediamtx/api";
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
