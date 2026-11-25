import { describe, expect, it } from "vitest";
import { gigabytes, linkSpeed, mbps, memoryUsed, sortFindings, splitInterfaces } from "./hostFormat";
import type { HostInterface } from "./types";

const ifc = (name: string, up: boolean, virtual = false): HostInterface => ({
  name, up, virtual, speedMbps: 1000, rxBytes: 0, txBytes: 0, rxBps: 0, txBps: 0, recentErrors: 0,
});

describe("host formatting", () => {
  it("puts warnings first and keeps the order inside a level", () => {
    const sorted = sortFindings([
      { id: "a", level: "ok" }, { id: "b", level: "info" }, { id: "c", level: "warn" }, { id: "d", level: "info" }, { id: "e", level: "warn" },
    ]);
    expect(sorted.map((f) => f.id)).toEqual(["c", "e", "b", "d", "a"]);
  });

  it("formats rates", () => {
    expect(mbps(0)).toBe("0");
    expect(mbps(50_000)).toBe("<0.1");
    expect(mbps(42_500_000)).toBe("42.5");
    expect(mbps(412_400_000)).toBe("412");
  });

  it("formats link speed", () => {
    expect(linkSpeed(0)).toBeNull();
    expect(linkSpeed(100)).toEqual({ value: 100, unit: "mbps" });
    expect(linkSpeed(2500)).toEqual({ value: 2.5, unit: "gbps" });
    expect(linkSpeed(10000)).toEqual({ value: 10, unit: "gbps" });
  });

  it("shows physical interfaces that are up first, virtual ones apart", () => {
    const { physical, virtual } = splitInterfaces([ifc("lo", true, true), ifc("eth1", false), ifc("eth0", true), ifc("docker0", true, true)]);
    expect(physical.map((i) => i.name)).toEqual(["eth0", "eth1"]);
    expect(virtual.map((i) => i.name)).toEqual(["docker0", "lo"]);
  });

  it("computes memory use without dividing by zero", () => {
    expect(memoryUsed(0, 0)).toBe(0);
    expect(memoryUsed(1000, 250)).toBe(75);
    expect(memoryUsed(1000, 2000)).toBe(0);
    expect(gigabytes(16 * 1024 * 1024)).toBe("16.0");
  });
});
