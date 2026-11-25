import type { AgentService, AgentStreamSpec, BackupMode, StreamKind } from "./types";

/** String-based model of the service editor; numbers stay text until the form is validated. */
export interface ServiceForm {
  /** Present when editing; empty for a new service (the agent derives it from the name). */
  id: string;
  name: string;
  enabled: boolean;
  inputs: Array<{ url: string; timeoutSec: string }>;
  backupMode: BackupMode;
  returnDelaySec: string;
  serviceId: string;
  pmtPid: string;
  provider: string;
  cbrKbps: string;
  streams: Array<{ pid: string; kind: StreamKind; lang: string; fallbackAny: boolean }>;
  outputs: Array<{ url: string }>;
}

/** The structure the downstream device usually expects: one video and two audio languages. */
export const DEFAULT_STREAMS: ServiceForm["streams"] = [
  { pid: "256", kind: "video", lang: "", fallbackAny: false },
  { pid: "257", kind: "audio", lang: "spa", fallbackAny: true },
  { pid: "258", kind: "audio", lang: "eng", fallbackAny: false },
];

export const EMPTY_SERVICE_FORM: ServiceForm = {
  id: "",
  name: "",
  enabled: true,
  inputs: [{ url: "", timeoutSec: "" }],
  backupMode: "active",
  returnDelaySec: "30",
  serviceId: "100",
  pmtPid: "4096",
  provider: "",
  cbrKbps: "",
  streams: DEFAULT_STREAMS.map((s) => ({ ...s })),
  outputs: [{ url: "" }],
};

export function serviceToForm(s: AgentService): ServiceForm {
  return {
    id: s.id,
    name: s.name,
    enabled: s.enabled,
    inputs: s.inputs.map((i) => ({ url: i.url, timeoutSec: i.timeoutSec ? String(i.timeoutSec) : "" })),
    backupMode: s.backup.mode,
    returnDelaySec: String(s.backup.returnDelaySec ?? 30),
    serviceId: String(s.profile.serviceId),
    pmtPid: String(s.profile.pmtPid),
    provider: s.profile.provider ?? "",
    cbrKbps: s.profile.cbrKbps ? String(s.profile.cbrKbps) : "",
    streams: s.profile.streams.map((st) => ({
      pid: String(st.pid), kind: st.kind, lang: st.lang ?? "", fallbackAny: st.fallbackAny === true,
    })),
    outputs: s.outputs.map((o) => ({ url: o.url })),
  };
}

const int = (text: string): number => (/^\d+$/.test(text.trim()) ? Number(text.trim()) : NaN);

export function formToService(f: ServiceForm): Omit<AgentService, "id"> & { id?: string } {
  const streams: AgentStreamSpec[] = f.streams.map((s) => ({
    pid: int(s.pid),
    kind: s.kind,
    ...(s.lang.trim() ? { lang: s.lang.trim().toLowerCase() } : {}),
    ...(s.fallbackAny ? { fallbackAny: true } : {}),
  }));
  return {
    ...(f.id ? { id: f.id } : {}),
    name: f.name.trim(),
    enabled: f.enabled,
    inputs: f.inputs.map((i) => ({ url: i.url.trim(), ...(i.timeoutSec.trim() ? { timeoutSec: int(i.timeoutSec) } : {}) })),
    backup: { mode: f.backupMode, returnDelaySec: int(f.returnDelaySec) || 30 },
    profile: {
      serviceId: int(f.serviceId),
      pmtPid: int(f.pmtPid),
      name: f.name.trim(),
      ...(f.provider.trim() ? { provider: f.provider.trim() } : {}),
      ...(f.cbrKbps.trim() ? { cbrKbps: int(f.cbrKbps) } : {}),
      streams,
    },
    outputs: f.outputs.map((o) => ({ url: o.url.trim() })),
  };
}

// ---- validation (mirrors the agent so most mistakes are caught before sending) ----

export type ServiceFormErrorCode =
  | "name-required"
  | "address-invalid"
  | "input-scheme"
  | "output-scheme"
  | "output-cbr"
  | "timeout-invalid"
  | "service-id-invalid"
  | "pid-invalid"
  | "pid-duplicate"
  | "lang-invalid"
  | "cbr-invalid"
  | "delay-invalid"
  | "streams-required"
  | "inputs-required"
  | "outputs-required";

export interface ServiceFormErrors {
  name?: ServiceFormErrorCode;
  serviceId?: ServiceFormErrorCode;
  pmtPid?: ServiceFormErrorCode;
  cbrKbps?: ServiceFormErrorCode;
  returnDelaySec?: ServiceFormErrorCode;
  inputs: Array<{ url?: ServiceFormErrorCode; timeoutSec?: ServiceFormErrorCode }>;
  outputs: Array<{ url?: ServiceFormErrorCode }>;
  streams: Array<{ pid?: ServiceFormErrorCode; lang?: ServiceFormErrorCode }>;
  /** Set when a list is empty. */
  general?: ServiceFormErrorCode;
}

export const MAX_INPUTS = 8;
export const MAX_OUTPUTS = 8;

const INPUT_SCHEMES = ["udp", "rtp", "http", "https", "mediamtx", "rtsp", "rtsps", "rtmp", "rtmps", "srt", "file"];
const OUTPUT_SCHEMES = ["udp", "rtp", "mediamtx", "rtmp", "rtmps", "srt", "rtsp", "rtsps", "file"];

/** Checks `type://address#options`; returns the problem or null. */
export function checkAddress(text: string, schemes: readonly string[], kind: "input" | "output"): ServiceFormErrorCode | null {
  const match = /^([a-z][a-z0-9+.-]*):\/\/([^#]+)(#.*)?$/i.exec(text.trim());
  if (!match) return "address-invalid";
  if (!schemes.includes(match[1]!.toLowerCase())) return kind === "input" ? "input-scheme" : "output-scheme";
  if (kind === "output" && /[#&]cbr=/.test(match[3] ?? "")) return "output-cbr";
  return null;
}

const validPid = (n: number) => Number.isInteger(n) && n >= 0x20 && n <= 0x1ffe;

export function validateServiceForm(f: ServiceForm): ServiceFormErrors {
  const errors: ServiceFormErrors = { inputs: [], outputs: [], streams: [] };
  if (!f.name.trim()) errors.name = "name-required";

  if (f.inputs.length === 0) errors.general = "inputs-required";
  f.inputs.forEach((input, i) => {
    const e: ServiceFormErrors["inputs"][number] = {};
    const problem = checkAddress(input.url, INPUT_SCHEMES, "input");
    if (problem) e.url = problem;
    if (input.timeoutSec.trim() && !(int(input.timeoutSec) >= 1)) e.timeoutSec = "timeout-invalid";
    errors.inputs[i] = e;
  });

  if (f.outputs.length === 0) errors.general = errors.general ?? "outputs-required";
  f.outputs.forEach((output, i) => {
    const problem = checkAddress(output.url, OUTPUT_SCHEMES, "output");
    errors.outputs[i] = problem ? { url: problem } : {};
  });

  const serviceId = int(f.serviceId);
  if (!(serviceId >= 1 && serviceId <= 65535)) errors.serviceId = "service-id-invalid";
  const pmt = int(f.pmtPid);
  if (!validPid(pmt)) errors.pmtPid = "pid-invalid";
  if (f.cbrKbps.trim() && !(int(f.cbrKbps) >= 1)) errors.cbrKbps = "cbr-invalid";
  if (f.backupMode === "active" && f.returnDelaySec.trim() && Number.isNaN(int(f.returnDelaySec))) errors.returnDelaySec = "delay-invalid";

  if (f.streams.length === 0) errors.general = errors.general ?? "streams-required";
  const used = new Map<number, number>();
  if (validPid(pmt)) used.set(pmt, -1);
  f.streams.forEach((stream, i) => {
    const e: ServiceFormErrors["streams"][number] = {};
    const pid = int(stream.pid);
    if (!validPid(pid)) e.pid = "pid-invalid";
    else if (used.has(pid)) e.pid = "pid-duplicate";
    else used.set(pid, i);
    if (stream.lang.trim() && !/^[a-zA-Z]{3}$/.test(stream.lang.trim())) e.lang = "lang-invalid";
    errors.streams[i] = e;
  });
  return errors;
}

export function hasErrors(e: ServiceFormErrors): boolean {
  return Boolean(
    e.name || e.serviceId || e.pmtPid || e.cbrKbps || e.returnDelaySec || e.general ||
      e.inputs.some((x) => x.url || x.timeoutSec) || e.outputs.some((x) => x.url) || e.streams.some((x) => x.pid || x.lang),
  );
}
