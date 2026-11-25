import { normalizeApiUrl } from "./http";
import { ENDPOINT_ORDER, SERVER_COLORS, type EndpointType, type Server } from "./types";

export const EXPORT_FORMAT = "nodo/servers";
/** Format name used before the project was renamed; still accepted on import. */
const LEGACY_EXPORT_FORMAT = "mediamtx-panel/servers";
export const EXPORT_VERSION = 1;

interface ExportFile {
  format: typeof EXPORT_FORMAT;
  version: number;
  servers: Array<Omit<Server, "password"> & { password?: string }>;
}

export function newId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `s_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

export function exportServers(servers: Server[], includePasswords: boolean): string {
  const file: ExportFile = {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    servers: servers.map((s) => {
      const { password, ...rest } = s;
      return includePasswords ? { ...rest, password } : rest;
    }),
  };
  return JSON.stringify(file, null, 2);
}

export interface ImportResult {
  servers: Server[];
  /** Human-readable problems, one per skipped or fixed entry. */
  warnings: string[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const asString = (value: unknown): string => (typeof value === "string" ? value : "");

/**
 * Parses an exported file. Throws on input that is not an export at all;
 * individual bad entries are skipped and reported in `warnings`.
 * Ids that already exist are regenerated so imports never overwrite servers.
 */
export function parseImport(text: string, existingIds: ReadonlySet<string> = new Set()): ImportResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("invalid-json");
  }
  if (!isRecord(raw) || (raw.format !== EXPORT_FORMAT && raw.format !== LEGACY_EXPORT_FORMAT) || !Array.isArray(raw.servers)) {
    throw new Error("invalid-format");
  }
  const warnings: string[] = [];
  const servers: Server[] = [];
  const usedIds = new Set(existingIds);

  raw.servers.forEach((entry, index) => {
    if (!isRecord(entry)) {
      warnings.push(`#${index + 1}: not an object`);
      return;
    }
    const name = asString(entry.name).trim();
    if (!name) {
      warnings.push(`#${index + 1}: missing name`);
      return;
    }
    const endpoints = Array.isArray(entry.endpoints)
      ? entry.endpoints.flatMap((e) => {
          if (!isRecord(e)) return [];
          const type = asString(e.type) as EndpointType;
          const apiUrl = normalizeApiUrl(asString(e.apiUrl));
          return ENDPOINT_ORDER.includes(type) && apiUrl ? [{ type, apiUrl }] : [];
        })
      : [];
    if (endpoints.length === 0) {
      warnings.push(`${name}: no valid endpoints`);
      return;
    }
    let id = asString(entry.id);
    if (!id || usedIds.has(id)) id = newId();
    usedIds.add(id);
    servers.push({
      id,
      name,
      color: asString(entry.color) || SERVER_COLORS[0],
      endpoints,
      username: asString(entry.username),
      password: asString(entry.password),
    });
  });

  return { servers, warnings };
}
