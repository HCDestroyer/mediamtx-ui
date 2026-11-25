import type { HostFinding, HostInterface } from "./types";

/** Warnings first, then suggestions, then what is fine. Stable inside each level. */
export function sortFindings(findings: HostFinding[]): HostFinding[] {
  const rank = { warn: 0, info: 1, ok: 2 } as const;
  return [...findings].sort((a, b) => rank[a.level] - rank[b.level]);
}

/** "42.5" for rates under 100 Mbps, "412" above; bits per second in, Mbps out. */
export function mbps(bps: number): string {
  const value = bps / 1e6;
  if (value === 0) return "0";
  if (value < 0.1) return "<0.1";
  return value < 100 ? value.toFixed(1) : String(Math.round(value));
}

/** Link speed in the unit people expect: 100 Mbps, 1 Gbps, 2.5 Gbps. */
export function linkSpeed(speedMbps: number): { value: number; unit: "mbps" | "gbps" } | null {
  if (speedMbps <= 0) return null;
  return speedMbps >= 1000 ? { value: speedMbps / 1000, unit: "gbps" } : { value: speedMbps, unit: "mbps" };
}

/** Physical interfaces first (up before down), virtual ones apart. */
export function splitInterfaces(list: HostInterface[]): { physical: HostInterface[]; virtual: HostInterface[] } {
  const byName = (a: HostInterface, b: HostInterface) => a.name.localeCompare(b.name);
  const physical = list.filter((i) => !i.virtual).sort((a, b) => Number(b.up) - Number(a.up) || byName(a, b));
  const virtual = list.filter((i) => i.virtual).sort(byName);
  return { physical, virtual };
}

export function gigabytes(kb: number): string {
  return (kb / 1024 / 1024).toFixed(1);
}

/** Percentage of memory in use, 0-100. */
export function memoryUsed(totalKB: number, availableKB: number): number {
  if (totalKB <= 0) return 0;
  return Math.min(100, Math.max(0, (100 * (totalKB - availableKB)) / totalKB));
}
