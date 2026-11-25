import { MASK, maskUrlSecrets } from "./mask";
import type { RawPathConf } from "./mediamtx/types";

export { maskUrlSecrets };

/** Minimal YAML writer for configuration data: scalars, arrays and nested objects. */

const PLAIN = /^[A-Za-z0-9_./@%+~-]+$/;
const RESERVED = /^(true|false|yes|no|on|off|null|~|y|n)$/i;
const LOOKS_NUMERIC = /^[-+]?(\d[\d_]*\.?\d*|\.\d+)([eE][-+]?\d+)?$|^0[xob][0-9a-f]+$/i;

function scalar(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "boolean" || typeof value === "number") return String(value);
  const text = String(value);
  // Double-quoted YAML is a superset of JSON strings, so JSON escaping is always valid.
  if (text === "" || !PLAIN.test(text) || RESERVED.test(text) || LOOKS_NUMERIC.test(text) || text.startsWith("-")) {
    return JSON.stringify(text);
  }
  return text;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function emit(value: unknown, indent: number, lines: string[]): void {
  const pad = " ".repeat(indent);
  if (Array.isArray(value)) {
    for (const item of value) {
      if (isObject(item) && Object.keys(item).length > 0) {
        const nested: string[] = [];
        emit(item, indent + 2, nested);
        lines.push(`${pad}- ${nested[0]!.trimStart()}`, ...nested.slice(1));
      } else if (Array.isArray(item) && item.length > 0) {
        const nested: string[] = [];
        emit(item, indent + 2, nested);
        lines.push(`${pad}- ${nested[0]!.trimStart()}`, ...nested.slice(1));
      } else {
        lines.push(`${pad}- ${inline(item)}`);
      }
    }
    return;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const name = scalar(key);
    if ((isObject(child) && Object.keys(child).length > 0) || (Array.isArray(child) && child.length > 0)) {
      lines.push(`${pad}${name}:`);
      emit(child, indent + 2, lines);
    } else {
      lines.push(`${pad}${name}: ${inline(child)}`);
    }
  }
}

function inline(value: unknown): string {
  if (Array.isArray(value)) return "[]";
  if (isObject(value)) return "{}";
  return scalar(value);
}

export function toYaml(value: unknown): string {
  if (!isObject(value) && !Array.isArray(value)) return `${scalar(value)}\n`;
  const lines: string[] = [];
  emit(value, 0, lines);
  return `${lines.join("\n")}\n`;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== "object") return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

/** A configured path without the fields that equal the path defaults, `name` and empty values. */
export function minimalPathConf(conf: RawPathConf, defaults: RawPathConf | null): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(conf)) {
    if (key === "name" || value === null || value === undefined) continue;
    if (defaults && deepEqual(value, defaults[key])) continue;
    // Deprecated twins of the renamed hooks come back as null/empty and say nothing.
    if (value === "" || (Array.isArray(value) && value.length === 0)) {
      if (!defaults || defaults[key] === undefined || value === defaults[key]) continue;
    }
    out[key] = value;
  }
  // `source` first makes the file easier to scan.
  const { source, ...rest } = out;
  return source === undefined ? rest : { source, ...rest };
}

/** Fields whose values are secrets; the preview can hide them. */
const SECRET_KEYS = new Set(["srtReadPassphrase", "srtPublishPassphrase", "whipBearerToken"]);

function maskSecrets(value: unknown, key = ""): unknown {
  if (Array.isArray(value)) return value.map((v) => maskSecrets(v, key));
  if (isObject(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, maskSecrets(v, k)]));
  if (typeof value !== "string" || value === "") return value;
  if (SECRET_KEYS.has(key)) return MASK;
  if (key === "source" || key === "dest") return maskUrlSecrets(value);
  return value;
}

export interface PathsYamlOptions {
  defaults: RawPathConf | null;
  /** Replace credentials with bullets (for on-screen preview). */
  mask?: boolean;
  header?: string;
}

/** The `paths:` section of `mediamtx.yml` for the given configured paths. */
export function pathsToYaml(confs: readonly RawPathConf[], options: PathsYamlOptions): string {
  const paths: Record<string, unknown> = {};
  for (const conf of confs) {
    if (!conf.name) continue;
    const minimal = minimalPathConf(conf, options.defaults);
    paths[conf.name] = options.mask ? maskSecrets(minimal) : minimal;
  }
  const header = options.header ? `${options.header.split("\n").map((l) => `# ${l}`).join("\n")}\n` : "";
  return `${header}paths:\n${indentBlock(toYaml(paths), 2)}`;
}

function indentBlock(text: string, spaces: number): string {
  const pad = " ".repeat(spaces);
  return text.replace(/\n$/, "").split("\n").map((line) => `${pad}${line}`).join("\n") + "\n";
}

/** One path as the YAML block to paste under `paths:`. */
export function pathToYaml(conf: RawPathConf, options: PathsYamlOptions): string {
  return pathsToYaml([conf], options);
}
