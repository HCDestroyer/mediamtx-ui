import { describe, expect, it } from "vitest";
import { formatAgo, formatBytes, formatMbps, formatSince } from "./format";

describe("format", () => {
  it("formats Mbps and the unknown state", () => {
    expect(formatMbps(null)).toBe("—");
    expect(formatMbps(undefined)).toBe("—");
    expect(formatMbps(6.24)).toBe("6,2");
    expect(formatMbps(0)).toBe("0,0");
  });

  it("formats byte sizes", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1536)).toBe("1,5 KB");
    expect(formatBytes(8.4 * 1024 ** 3)).toBe("8,4 GB");
    expect(formatBytes(-5)).toBe("0 B");
  });

  it("formats how long a channel has been live", () => {
    const now = Date.parse("2026-11-25T12:00:00Z");
    expect(formatSince("2026-11-25T09:46:00Z", now)).toBe("2 h 14 min");
    expect(formatSince("2026-11-25T11:55:00Z", now)).toBe("5 min");
    expect(formatSince("2026-11-25T11:59:20Z", now)).toBe("40 s");
    expect(formatSince("2026-11-20T09:00:00Z", now)).toBe("5 d 3 h");
    expect(formatSince(null, now)).toBe("—");
    expect(formatSince("2027-01-01T00:00:00Z", now)).toBe("—");
    expect(formatSince("garbage", now)).toBe("—");
  });

  it("formats the age of the last update", () => {
    expect(formatAgo(null, 1000)).toBe("—");
    expect(formatAgo(1000, 4000)).toBe("hace 3 s");
    expect(formatAgo(0, 120_000)).toBe("hace 2 min");
  });
});
