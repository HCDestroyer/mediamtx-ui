import type { RawPathConf } from "./types";

/** SRT passphrases must be 10 to 79 characters long. */
export const PASSPHRASE_MIN = 10;
export const PASSPHRASE_MAX = 79;

/**
 * Hook keys differ by version: v1.21 renamed `runOnReady` to `runOnOnline` and
 * deprecated the old one. The path defaults list which of them the server knows.
 */
export interface HookKeys {
  command: string;
  restart: string;
}

export function detectHookKeys(defaults: Record<string, unknown> | null | undefined): HookKeys {
  return defaults && "runOnOnline" in defaults
    ? { command: "runOnOnline", restart: "runOnOnlineRestart" }
    : { command: "runOnReady", restart: "runOnReadyRestart" };
}

// ---- source ----

export type SourceMode = "publisher" | "url" | "other";

const URL_SOURCE = /^(rtsps?(\+(http|ws))?|rtmps?|https?|udp\+mpegts|unix\+mpegts|udp\+rtp|srt|moqt|wheps?):\/\//i;

/** `publisher` means a client publishes into the path; `other` covers redirect and rpiCamera, kept untouched. */
export function sourceMode(source: string | undefined | null): SourceMode {
  if (!source || source === "publisher") return "publisher";
  return URL_SOURCE.test(source) ? "url" : "other";
}

const isSrt = (url: string) => /^srt:\/\//i.test(url);

export function getSourcePassphrase(url: string): string {
  const match = /[?&]passphrase=([^&#]*)/.exec(url);
  if (!match?.[1]) return "";
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

/** Sets or removes the `passphrase` query parameter of an SRT URL, leaving everything else as typed. */
export function setSourcePassphrase(url: string, passphrase: string): string {
  const stripped = url.replace(/([?&])passphrase=[^&#]*&?/, "$1").replace(/[?&]$/, "");
  if (!passphrase) return stripped;
  return `${stripped}${stripped.includes("?") ? "&" : "?"}passphrase=${encodeURIComponent(passphrase)}`;
}

// ---- form ----

export interface PathForm {
  name: string;
  sourceMode: SourceMode;
  /** For `url`: the URL without its SRT passphrase. For `other`: the raw value, shown read-only. */
  sourceUrl: string;
  /** Passphrase embedded in a pulled SRT source URL. */
  sourcePassphrase: string;
  sourceOnDemand: boolean;
  srtPublishPassphrase: string;
  srtReadPassphrase: string;
  hookCommand: string;
  hookRestart: boolean;
  record: boolean;
  recordPath: string;
  recordFormat: "fmp4" | "mpegts";
  recordSegmentDuration: string;
  recordDeleteAfter: string;
}

export const EMPTY_FORM: PathForm = {
  name: "",
  sourceMode: "publisher",
  sourceUrl: "",
  sourcePassphrase: "",
  sourceOnDemand: false,
  srtPublishPassphrase: "",
  srtReadPassphrase: "",
  hookCommand: "",
  hookRestart: false,
  record: false,
  recordPath: "./recordings/%path/%Y-%m-%d_%H-%M-%S-%f_%z",
  recordFormat: "fmp4",
  recordSegmentDuration: "1h",
  recordDeleteAfter: "1d",
};

const str = (value: unknown, fallback = ""): string => (typeof value === "string" ? value : fallback);
const bool = (value: unknown): boolean => value === true;

export function confToForm(name: string, conf: RawPathConf, hook: HookKeys): PathForm {
  const source = str(conf.source, "publisher");
  const mode = sourceMode(source);
  const withoutPassphrase = mode === "url" && isSrt(source) ? setSourcePassphrase(source, "") : source;
  return {
    name,
    sourceMode: mode,
    sourceUrl: mode === "publisher" ? "" : withoutPassphrase,
    sourcePassphrase: mode === "url" && isSrt(source) ? getSourcePassphrase(source) : "",
    sourceOnDemand: bool(conf.sourceOnDemand),
    srtPublishPassphrase: str(conf.srtPublishPassphrase),
    srtReadPassphrase: str(conf.srtReadPassphrase),
    hookCommand: str(conf[hook.command]),
    hookRestart: bool(conf[hook.restart]),
    record: bool(conf.record),
    recordPath: str(conf.recordPath, EMPTY_FORM.recordPath),
    recordFormat: conf.recordFormat === "mpegts" ? "mpegts" : "fmp4",
    recordSegmentDuration: str(conf.recordSegmentDuration, EMPTY_FORM.recordSegmentDuration),
    recordDeleteAfter: str(conf.recordDeleteAfter, EMPTY_FORM.recordDeleteAfter),
  };
}

/** Every field the editor manages, as the API expects it. */
export function formToConf(form: PathForm, hook: HookKeys): Record<string, unknown> {
  let source: string;
  if (form.sourceMode === "publisher") source = "publisher";
  else if (form.sourceMode === "other") source = form.sourceUrl;
  else {
    const url = form.sourceUrl.trim();
    source = isSrt(url) ? setSourcePassphrase(url, form.sourcePassphrase) : url;
  }
  return {
    source,
    sourceOnDemand: form.sourceMode === "url" && form.sourceOnDemand,
    srtPublishPassphrase: form.srtPublishPassphrase,
    srtReadPassphrase: form.srtReadPassphrase,
    [hook.command]: form.hookCommand.trim(),
    [hook.restart]: form.hookRestart,
    record: form.record,
    recordPath: form.recordPath.trim(),
    recordFormat: form.recordFormat,
    recordSegmentDuration: form.recordSegmentDuration.trim(),
    recordDeleteAfter: form.recordDeleteAfter.trim(),
  };
}

/**
 * Body for `PATCH`: only what differs from the configuration the server returned.
 * The baseline goes through the same form conversion as the edited values, so a
 * field the server did not report cannot show up as a change.
 */
export function buildPatch(original: RawPathConf, form: PathForm, hook: HookKeys): Record<string, unknown> {
  const wanted = formToConf(form, hook);
  const baseline = formToConf(confToForm(form.name, original, hook), hook);
  const patch: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(wanted)) {
    if (baseline[key] !== value) patch[key] = value;
  }
  return patch;
}

/** Body for `POST`: only what differs from the path defaults, so the new path stays small. */
export function buildCreate(
  form: PathForm,
  hook: HookKeys,
  defaults: RawPathConf | null,
): Record<string, unknown> {
  const wanted = formToConf(form, hook);
  const body: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(wanted)) {
    const fallback = defaults?.[key] ?? (typeof value === "string" ? "" : false);
    if (fallback !== value) body[key] = value;
  }
  return body;
}

// ---- validation ----

export type FormErrorCode =
  | "name-required"
  | "name-invalid"
  | "name-exists"
  | "source-required"
  | "source-invalid"
  | "passphrase-length"
  | "duration-invalid"
  | "record-path-required";

export type FormErrors = Partial<Record<keyof PathForm, FormErrorCode>>;

const NAME_PATTERN = /^[\w.\-~]+(\/[\w.\-~]+)*$/;

export function validatePathName(name: string): FormErrorCode | null {
  const trimmed = name.trim();
  if (!trimmed) return "name-required";
  // A leading tilde marks a regular expression, which can contain anything.
  if (trimmed.startsWith("~")) return trimmed.length > 1 ? null : "name-invalid";
  return NAME_PATTERN.test(trimmed) ? null : "name-invalid";
}

export function validatePassphrase(passphrase: string): FormErrorCode | null {
  if (passphrase === "") return null;
  return passphrase.length >= PASSPHRASE_MIN && passphrase.length <= PASSPHRASE_MAX ? null : "passphrase-length";
}

const DURATION = /^\d+(\.\d+)?(ms|s|m|h|d)$/;

export function validateForm(
  form: PathForm,
  options: { creating: boolean; existingNames?: readonly string[] },
): FormErrors {
  const errors: FormErrors = {};
  if (options.creating) {
    const nameError = validatePathName(form.name);
    if (nameError) errors.name = nameError;
    else if (options.existingNames?.includes(form.name.trim())) errors.name = "name-exists";
  }
  if (form.sourceMode === "url") {
    const url = form.sourceUrl.trim();
    if (!url) errors.sourceUrl = "source-required";
    else if (!URL_SOURCE.test(url) || /^[a-z+]+:\/\/$/i.test(url)) errors.sourceUrl = "source-invalid";
    if (isSrt(url)) {
      const passphraseError = validatePassphrase(form.sourcePassphrase);
      if (passphraseError) errors.sourcePassphrase = passphraseError;
    }
  }
  for (const key of ["srtPublishPassphrase", "srtReadPassphrase"] as const) {
    const error = validatePassphrase(form[key]);
    if (error) errors[key] = error;
  }
  if (form.record) {
    if (!form.recordPath.trim()) errors.recordPath = "record-path-required";
    for (const key of ["recordSegmentDuration", "recordDeleteAfter"] as const) {
      if (!DURATION.test(form[key].trim())) errors[key] = "duration-invalid";
    }
  }
  return errors;
}
