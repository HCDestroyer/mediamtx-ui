/** JSON of the nodo-agent API (see agent/README.md). */

export type StreamKind = "video" | "audio" | "subtitle" | "data";
export type BackupMode = "active" | "manual";

export interface AgentStreamSpec {
  pid: number;
  kind: StreamKind;
  lang?: string;
  codec?: string;
  index?: number;
  /** When no stream matches the language, take another of the same kind. */
  fallbackAny?: boolean;
}

export interface AgentProfile {
  serviceId: number;
  pmtPid: number;
  name?: string;
  provider?: string;
  pcrPid?: number;
  streams: AgentStreamSpec[];
  cbrKbps?: number;
}

export interface AgentInputSpec {
  url: string;
  timeoutSec?: number;
}

export interface AgentService {
  id: string;
  name: string;
  enabled: boolean;
  inputs: AgentInputSpec[];
  backup: { mode: BackupMode; returnDelaySec?: number };
  profile: AgentProfile;
  outputs: Array<{ url: string }>;
}

export interface AgentProgramStream {
  pid: number;
  type: number;
  kind: StreamKind;
  codec: string;
  lang?: string;
}

export interface AgentProgram {
  number: number;
  pmtPid: number;
  pcrPid: number;
  version: number;
  streams: AgentProgramStream[];
}

export interface AgentInputStatus {
  index: number;
  url: string;
  up: boolean;
  active: boolean;
  kbps: number;
  ccErrors: number;
  /** Milliseconds since the last data, or -1 when none arrived yet. */
  lastDataMs: number;
  lastError?: string;
  program?: AgentProgram;
}

export interface AgentOutputStatus {
  index: number;
  url: string;
  up: boolean;
  dropped: number;
  lastError?: string;
}

export type MapState = "ok" | "fallback" | "missing";

export interface AgentMapEntry {
  outPid: number;
  inPid?: number;
  state: MapState;
  kind: StreamKind;
  lang?: string;
}

export interface AgentEvent {
  at: string;
  level: "info" | "warn" | "error";
  message: string;
}

export interface AgentStatus {
  state: "running" | "stopped";
  /** Index of the active input, or -1. */
  activeInput: number;
  uptimeSec: number;
  outKbps: number;
  pmtVersion: number;
  inputs: AgentInputStatus[];
  mapping: AgentMapEntry[];
  outputs: AgentOutputStatus[];
  events: AgentEvent[];
}

export interface AgentView {
  service: AgentService;
  status: AgentStatus;
}

export interface AgentInfo {
  version: string;
  /** First line of `ffmpeg -version`, empty when FFmpeg is not installed. */
  ffmpeg: string;
  mediamtx: boolean;
  startedAt: number;
}
