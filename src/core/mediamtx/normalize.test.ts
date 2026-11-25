import { describe, expect, it } from "vitest";
import { isPatternConf, mergeChannels, normalizePath } from "./normalize";
import type { RawPath } from "./types";

/** Shape sent by MediaMTX v1.21. */
const modern: RawPath = {
  name: "canal63",
  confName: "canal63",
  source: { type: "srtSource", id: "srt://127.0.0.1:3333" },
  available: true,
  online: true,
  tracks2: [
    { codec: "H264", codecProps: { width: 1920, height: 1080, profile: "High", level: "4.1" } },
    { codec: "MPEG-4 Audio", codecProps: { sampleRate: 48000, channelCount: 2 } },
  ],
  inboundBytes: 1000,
  outboundBytes: 3000,
  onlineTime: "2026-11-25T10:00:00Z",
  readers: [{ type: "rtspSession", id: "x" }],
  readerCount: 1,
};

/** Shape sent by servers before `online` and `tracks2` existed. */
const legacy: RawPath = {
  name: "canal65",
  confName: "all_others",
  source: { type: "rtmpConn", id: "abc" },
  ready: true,
  readyTime: "2026-11-25T09:00:00Z",
  tracks: ["H264", "MPEG-4 Audio"],
  bytesReceived: 500,
  bytesSent: 1500,
  readers: [{ type: "hlsSession", id: "1" }, { type: "webRTCSession", id: "2" }],
};

describe("normalizePath", () => {
  it("reads the v1.21 shape", () => {
    const channel = normalizePath(modern);
    expect(channel).toMatchObject({
      name: "canal63", kind: "configured", live: true, readerCount: 1, bytesIn: 1000, bytesOut: 3000,
      liveSince: "2026-11-25T10:00:00Z", source: { type: "srtSource", id: "srt://127.0.0.1:3333" },
    });
    expect(channel.tracks).toEqual([
      { kind: "video", codec: "H264", detail: "1920×1080 · High" },
      { kind: "audio", codec: "MPEG-4 Audio", detail: "48 kHz · 2 ch" },
    ]);
  });

  it("reads the older shape (ready, tracks, bytesReceived)", () => {
    const channel = normalizePath(legacy);
    expect(channel).toMatchObject({
      live: true, kind: "dynamic", confName: "all_others", readerCount: 2, bytesIn: 500, bytesOut: 1500,
      liveSince: "2026-11-25T09:00:00Z",
    });
    expect(channel.tracks.map((t) => [t.kind, t.codec])).toEqual([["video", "H264"], ["audio", "MPEG-4 Audio"]]);
  });

  it("prefers online over the deprecated ready", () => {
    expect(normalizePath({ name: "a", online: false, ready: true }).live).toBe(false);
    expect(normalizePath({ name: "a", online: true, ready: false }).live).toBe(true);
    expect(normalizePath({ name: "a" }).live).toBe(false);
  });

  it("is not live when only available (always-available placeholder)", () => {
    expect(normalizePath({ name: "a", available: true, online: false }).live).toBe(false);
  });

  it("treats a path whose conf differs from its name as dynamic", () => {
    expect(normalizePath({ name: "cam1", confName: "~^cam\\d+$" }).kind).toBe("dynamic");
    expect(normalizePath({ name: "cam1", confName: "cam1" }).kind).toBe("configured");
    expect(normalizePath({ name: "cam1" }).kind).toBe("configured");
  });

  it("tolerates missing fields", () => {
    expect(normalizePath({ name: "x" })).toMatchObject({ readers: [], readerCount: 0, tracks: [], bytesIn: 0, source: null });
  });
});

describe("mergeChannels", () => {
  const confs = [{ name: "canal63" }, { name: "camara_patio" }, { name: "all_others" }, { name: "~^cam" }];

  it("adds configured paths that have no publisher as offline", () => {
    const merged = mergeChannels([normalizePath(modern)], confs);
    expect(merged.map((c) => [c.name, c.live])).toEqual([["canal63", true], ["camara_patio", false]]);
    expect(merged[1]).toMatchObject({ kind: "configured", readerCount: 0 });
  });

  it("never lists pattern entries as channels", () => {
    expect(isPatternConf("all_others")).toBe(true);
    expect(isPatternConf("~^cam")).toBe(true);
    expect(isPatternConf("canal63")).toBe(false);
    expect(mergeChannels([], confs).map((c) => c.name)).toEqual(["camara_patio", "canal63"]);
  });

  it("puts live channels first and sorts names with numbers naturally", () => {
    const runtime = ["canal10", "canal9", "canal2"].map((name) => normalizePath({ name, online: name !== "canal9" }));
    expect(mergeChannels(runtime, null).map((c) => c.name)).toEqual(["canal2", "canal10", "canal9"]);
  });

  it("works without the configuration list", () => {
    expect(mergeChannels([normalizePath(legacy)], null)).toHaveLength(1);
  });
});
