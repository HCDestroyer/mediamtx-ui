export interface Version {
  major: number;
  minor: number;
  patch: number;
}

/** Parses `v1.21.4`, `1.21.4` and tagged builds such as `v1.21.4-3-gabc`. */
export function parseVersion(text: string | null | undefined): Version | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(text?.trim() ?? "");
  return match ? { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) } : null;
}

export function compareVersions(a: Version, b: Version): number {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}

/** Version the panel is built against. */
export const TARGET_VERSION: Version = { major: 1, minor: 21, patch: 4 };
