import { describe, expect, it } from "vitest";
import { BitrateTracker } from "./bitrate";
import { summarize } from "./summary";
import type { Channel } from "./types";

const samples = (bytesIn: number, bytesOut: number) => new Map([["a", { bytesIn, bytesOut }]]);

describe("BitrateTracker", () => {
  it("has no rate on the first sample", () => {
    expect(new BitrateTracker().update(samples(0, 0), 1000).get("a")).toBeNull();
  });

  it("converts the byte delta between polls to Mbps", () => {
    const tracker = new BitrateTracker();
    tracker.update(samples(0, 0), 0);
    // 2.5 MB in 2 s = 10 Mbps in; 5 MB in 2 s = 20 Mbps out
    const rate = tracker.update(samples(2_500_000, 5_000_000), 2000).get("a");
    expect(rate?.inMbps).toBeCloseTo(10);
    expect(rate?.outMbps).toBeCloseTo(20);
  });

  it("treats a counter reset as zero instead of a negative rate", () => {
    const tracker = new BitrateTracker();
    tracker.update(samples(9_000_000, 9_000_000), 0);
    const rate = tracker.update(samples(1000, 1000), 2000).get("a");
    expect(rate).toEqual({ inMbps: 0, outMbps: 0 });
  });

  it("keeps the baseline when polls arrive too close together", () => {
    const tracker = new BitrateTracker();
    tracker.update(samples(0, 0), 0);
    expect(tracker.update(samples(100, 100), 50).get("a")).toBeNull();
    const rate = tracker.update(samples(1_250_000, 0), 1000).get("a");
    expect(rate?.inMbps).toBeCloseTo(10);
  });

  it("forgets channels that disappear", () => {
    const tracker = new BitrateTracker();
    tracker.update(samples(0, 0), 0);
    tracker.update(new Map(), 1000);
    expect(tracker.update(samples(5_000_000, 0), 2000).get("a")).toBeNull();
  });
});

describe("summarize", () => {
  const channel = (name: string, live: boolean, readerCount: number): Channel => ({
    name, confName: name, kind: "configured", live, source: null, readers: [], readerCount,
    tracks: [], bytesIn: 0, bytesOut: 0, liveSince: null,
  });

  it("counts live channels, readers and sums the rates", () => {
    const rates = new Map([["a", { inMbps: 6, outMbps: 8 }], ["b", { inMbps: 2, outMbps: 4 }], ["c", null]]);
    expect(summarize([channel("a", true, 3), channel("b", true, 2), channel("c", false, 0)], rates)).toEqual({
      live: 2, total: 3, readers: 5, inMbps: 8, outMbps: 12,
    });
  });
});
