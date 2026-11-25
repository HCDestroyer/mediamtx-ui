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

/** State of the additional MediaMTX configuration file (GET /api/v1/mediamtx/config). */
export interface MtxConfigState {
  basePath: string;
  baseFound: boolean;
  /** The generated file MediaMTX must be started with. */
  outPath: string;
  outFound: boolean;
  /** Text of the additional file. */
  overlay: string;
  /** True when changes are checked with `mediamtx --validate-conf`, false for the basic checks only. */
  validator: boolean;
  canUndo: boolean;
}

export type MtxValidation = { ok: true; merged: string } | { ok: false; error: string };

/** MediaMTX running as a child of the agent. */
export interface ProcessStatus {
  state: "stopped" | "starting" | "running" | "crashed";
  /** The operator wants it running (it comes back after an agent restart). */
  enabled: boolean;
  pid?: number;
  /** Unix seconds when the current process started. */
  since?: number;
  restarts: number;
  lastExit?: string;
  binary?: string;
}

export interface MediaMtxBinaries {
  /** Newest first. */
  installed: string[];
  /** Selected version, or an empty string. */
  current: string;
  /** Absent when the agent cannot run MediaMTX (no managed configuration). */
  process?: ProcessStatus;
}

export type ToolId = "ffmpeg" | "tsduck" | "dvblast";

export interface ToolInfo {
  id: ToolId;
  found: boolean;
  path?: string;
  version?: string;
}

export interface BinariesState {
  mediamtx: MediaMtxBinaries;
  tools: ToolInfo[];
}

export interface ProcessView {
  status: ProcessStatus;
  logs: string[];
}

export interface HostInterface {
  name: string;
  up: boolean;
  /** 0 when the driver does not report it. */
  speedMbps: number;
  /** Loopback, bridges, veth, tunnels: no physical device behind them. */
  virtual: boolean;
  rxBytes: number;
  txBytes: number;
  rxBps: number;
  txBps: number;
  /** Errors and drops over the last minute. */
  recentErrors: number;
}

export interface HostGpu {
  vendor: "nvidia" | "intel" | "amd" | "other";
  device: string;
  render?: string;
}

export interface HostDvbAdapter {
  index: number;
  frontends: number;
  vendor?: string;
  device?: string;
}

export interface HostPciCard {
  vendor: string;
  device: string;
  /** Empty when no driver is bound to the card. */
  driver?: string;
}

export type FindingLevel = "ok" | "info" | "warn";

/** One observation of the advisor. The agent sends the id and the numbers; the panel writes the text. */
export interface HostFinding {
  id: string;
  level: FindingLevel;
  params?: Record<string, string | number>;
}

export interface HostView {
  cpu: { model: string; cores: number };
  cpuUsage: number;
  memory: { totalKB: number; availableKB: number };
  uptimeSec: number;
  load: [number, number, number];
  rates: HostInterface[];
  udp: { inDatagrams: number; inErrors: number; rcvbufErrors: number };
  recentUdpDrops: number;
  gpus: HostGpu[];
  dvb: HostDvbAdapter[];
  pciCards: HostPciCard[];
  findings: HostFinding[];
}
