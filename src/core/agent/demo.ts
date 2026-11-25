import type { HttpRequest, HttpResponse, Transport } from "../http";
import { DEFAULT_PLAY_CONFIG, validatePlayConfig } from "./play";
import type {
  BinariesState, HostView, MtxConfigState, PlayClient, PlayConfig, ProcessStatus, AgentEvent, AgentInputStatus, AgentMapEntry, AgentProfile, AgentProgram, AgentService, AgentStatus, AgentView,
} from "./types";

/** Agent URL of the demo server; the demo transport answers by path and ignores the host. */
export const DEMO_AGENT_URL = "https://agent.demo.nodo.invalid";
export const DEMO_AGENT_TOKEN = "demo";

/** Two sources of the same channel with other PIDs and the audio languages in another order. */
const PROGRAMS: AgentProgram[] = [
  {
    number: 100, pmtPid: 4096, pcrPid: 1331, version: 0,
    streams: [
      { pid: 1331, type: 27, kind: "video", codec: "h264" },
      { pid: 1332, type: 15, kind: "audio", codec: "aac", lang: "eng" },
      { pid: 1333, type: 15, kind: "audio", codec: "aac", lang: "spa" },
    ],
  },
  {
    number: 7, pmtPid: 4000, pcrPid: 2000, version: 3,
    streams: [
      { pid: 2000, type: 27, kind: "video", codec: "h264" },
      { pid: 2001, type: 15, kind: "audio", codec: "aac", lang: "spa" },
      { pid: 2002, type: 15, kind: "audio", codec: "aac", lang: "eng" },
    ],
  },
];

/** Same rules as the agent: exact language first, then the leftovers of the same kind for `fallbackAny`. */
export function resolveMapping(profile: AgentProfile, program: AgentProgram | undefined): AgentMapEntry[] {
  const taken = new Set<number>();
  const result: AgentMapEntry[] = profile.streams.map((want) => ({
    outPid: want.pid, state: "missing", kind: want.kind, ...(want.lang ? { lang: want.lang } : {}),
  }));
  if (!program) return result;
  profile.streams.forEach((want, i) => {
    const hit = program.streams.find(
      (s) => !taken.has(s.pid) && s.kind === want.kind && (!want.lang || s.lang?.toLowerCase() === want.lang.toLowerCase()),
    );
    if (hit) {
      taken.add(hit.pid);
      result[i] = { ...result[i]!, inPid: hit.pid, state: "ok" };
    }
  });
  profile.streams.forEach((want, i) => {
    if (result[i]!.state !== "missing" || !want.fallbackAny) return;
    const hit = program.streams.find((s) => !taken.has(s.pid) && s.kind === want.kind);
    if (hit) {
      taken.add(hit.pid);
      result[i] = { ...result[i]!, inPid: hit.pid, state: "fallback" };
    }
  });
  return result;
}

const slug = (name: string) =>
  name.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);

interface Sim {
  service: AgentService;
  startedAt: number;
  active: number;
  events: AgentEvent[];
}

const INITIAL: AgentService = {
  id: "deportes-hd", name: "Deportes HD", enabled: true,
  inputs: [{ url: "udp://eth0@239.255.1.1:1234#pnr=100", timeoutSec: 5 }, { url: "mediamtx://respaldo_srt" }],
  backup: { mode: "active", returnDelaySec: 30 },
  profile: {
    serviceId: 100, pmtPid: 4096, name: "Deportes HD", provider: "Nodo", cbrKbps: 0,
    streams: [
      { pid: 256, kind: "video" },
      { pid: 257, kind: "audio", lang: "spa", fallbackAny: true },
      { pid: 258, kind: "audio", lang: "eng" },
    ],
  },
  outputs: [{ url: "udp://239.255.10.1:1234#ttl=32" }, { url: "mediamtx://deportes_hd" }],
};

/** In-memory stand-in for nodo-agent, used by demo mode. */
export function createDemoAgentTransport(now: () => number = Date.now): Transport {
  const sims = new Map<string, Sim>();
  const start = (service: AgentService): Sim => ({
    service, startedAt: now(), active: 0,
    events: [{ at: new Date(now()).toISOString(), level: "info", message: "Servicio iniciado" }],
  });
  // Additional MediaMTX configuration file, with the same one-step undo as the real agent.
  const mtx = { overlay: "", prev: null as string | null };
  /** Path changes received, in order: lets tests check what the panel persisted. */
  const mtxPaths: string[] = [];
  const mtxState = (): MtxConfigState => ({
    basePath: "/etc/mediamtx/mediamtx.yml", baseFound: true, outPath: "/etc/nodo/nodo/mediamtx/mediamtx.yml",
    outFound: true, overlay: mtx.overlay, validator: true, canUndo: mtx.prev !== null,
  });
  /** Mirrors the real checks that matter for the demo: unknown parameters and tab indentation. */
  const mtxProblem = (overlay: string): string | null => {
    if (overlay.includes("\t")) return "the additional configuration is not valid YAML: tabs cannot indent";
    const bad = /^\s*(badParam|unknownParam)\s*:/m.exec(overlay);
    return bad ? `json: unknown field "${bad[1]}"` : null;
  };
  // MediaMTX binaries and the supervised process.
  const bins = { installed: ["v1.21.4", "v1.20.2"], current: "v1.21.4", enabled: true, running: true, restarts: 0, startedAt: now() - 2 * 3600_000 };
  const procLogs = ["--- started v1.21.4", "INF MediaMTX v1.21.4", "INF [API] listener opened on :9997", "INF [RTSP] listener opened on :8554 (TCP)"];
  const versionOf = (v: string) => /^v\d+\.\d+\.\d+$/.test(v);
  const newest = () => [...bins.installed, "v1.21.5"].sort().at(-1)!;
  const procStatus = (): ProcessStatus => ({
    state: bins.running ? "running" : "stopped", enabled: bins.enabled, restarts: bins.restarts,
    ...(bins.running ? { pid: 4242, since: Math.floor(bins.startedAt / 1000), binary: `/etc/nodo/nodo/bin/mediamtx/versions/${bins.current}/mediamtx` } : {}),
  });
  const binSnapshot = () => ({ installed: [...bins.installed].sort().reverse(), current: bins.current, process: procStatus() });
  const binState = (): BinariesState => ({
    mediamtx: binSnapshot(),
    tools: [
      { id: "ffmpeg", found: true, path: "/usr/bin/ffmpeg", version: "ffmpeg version 6.1.1" },
      { id: "tsduck", found: false },
      { id: "dvblast", found: false },
    ],
  });
  const restartLog = () => {
    bins.startedAt = now();
    procLogs.push(`--- started ${bins.current}`, `INF MediaMTX ${bins.current}`);
  };
  // HTTP play: configuration is kept (and validated like the agent does); viewers come from a fixed list.
  let play: PlayConfig = structuredClone(DEFAULT_PLAY_CONFIG);
  const newToken = () => Array.from({ length: 32 }, () => "0123456789abcdef"[Math.floor(Math.random() * 16)]).join("");
  const playClients = (): PlayClient[] => {
    if (!play.enabled) return [];
    const since = Math.floor((now() - 25 * 60_000) / 1000);
    const viewers: PlayClient[] = [
      { id: 1, service: "deportes-hd", ip: "192.168.1.50", user: play.users[0]?.name, since, bytes: Math.floor((now() - since * 1000) * 700) },
      { id: 2, service: "deportes-hd", ip: "203.0.113.77", since: since + 600, bytes: Math.floor((now() - since * 1000 - 600_000) * 700) },
    ];
    // The agent refuses blocked addresses; the demo hides them the same way for single-address rules.
    const blocked = new Set(play.rules.filter((r) => r.action === "deny" && r.address).map((r) => r.address));
    return viewers.filter((v) => !blocked.has(v.ip));
  };

  /** A machine that has a few things worth advising on, so the demo shows each kind of recommendation. */
  const hostView = (): HostView => {
    const t = now() / 1000;
    const wave = (period: number, phase = 0) => 0.5 + 0.5 * Math.sin(t / period + phase);
    const eth = (name: string, rx: number, tx: number) => ({
      name, up: true, speedMbps: 1000, virtual: false, rxBytes: 9e11, txBytes: 4e12,
      rxBps: Math.round(rx * 1e6), txBps: Math.round(tx * 1e6), recentErrors: 0,
    });
    return {
      cpu: { model: "Intel(R) Xeon(R) E-2236 CPU @ 3.40GHz", cores: 6 },
      cpuUsage: 18 + 22 * wave(7),
      memory: { totalKB: 32_000_000, availableKB: Math.round(21_000_000 - 2_000_000 * wave(11)) },
      uptimeSec: 18 * 86400 + 4 * 3600,
      load: [1.2 + wave(9), 1.1, 0.9],
      rates: [
        eth("eth0", 38 + 14 * wave(5), 96 + 30 * wave(6, 1)),
        { ...eth("eth1", 0, 0), up: false, speedMbps: 0 },
        { ...eth("docker0", 0.1, 0.1), virtual: true, speedMbps: 0 },
        { ...eth("lo", 2, 2), virtual: true, speedMbps: 0 },
      ],
      udp: { inDatagrams: 91_000_000, inErrors: 12, rcvbufErrors: 12 },
      recentUdpDrops: 12,
      gpus: [],
      dvb: [],
      pciCards: [{ vendor: "tbs", device: "544d:6205" }],
      findings: [
        { id: "net-rmem-low", level: "warn", params: { drops: 12, rmemMax: 212992 } },
        { id: "dvb-driver-missing", level: "warn", params: { vendor: "tbs", device: "544d:6205" } },
        { id: "cpu-governor", level: "info", params: { governor: "powersave" } },
        { id: "gpu-none", level: "info" },
      ],
    };
  };
  const first = start(INITIAL);
  first.startedAt = now() - 3 * 3600_000;
  sims.set(INITIAL.id, first);

  const status = (sim: Sim): AgentStatus => {
    const { service } = sim;
    const running = service.enabled;
    const t = now();
    const inputs: AgentInputStatus[] = service.inputs.map((input, index) => {
      const program = PROGRAMS[index % PROGRAMS.length];
      return {
        index, url: input.url.replace(/(passphrase|key|pass)=[^&#]*/g, "$1=***"), up: running, active: running && index === sim.active,
        kbps: running ? 5200 + 400 * Math.sin(t / 3000 + index) : 0, ccErrors: running ? index * 3 : 0,
        lastDataMs: running ? 20 + Math.floor(40 * Math.abs(Math.sin(t / 700 + index))) : -1,
        ...(running && program ? { program } : {}),
      };
    });
    const activeProgram = running ? inputs[sim.active]?.program : undefined;
    return {
      state: running ? "running" : "stopped",
      activeInput: running ? sim.active : -1,
      uptimeSec: running ? Math.floor((t - sim.startedAt) / 1000) : 0,
      outKbps: running ? (service.profile.cbrKbps || 5600) + 30 * Math.sin(t / 2000) : 0,
      pmtVersion: 0,
      inputs,
      mapping: resolveMapping(service.profile, activeProgram),
      outputs: service.outputs.map((o, index) => ({ index, url: o.url, up: running, dropped: 0 })),
      events: [...sim.events].reverse(),
    };
  };
  const view = (sim: Sim): AgentView => ({ service: sim.service, status: status(sim) });
  const ok = (data: unknown, code = 200): HttpResponse => ({ status: code, ok: true, data });
  const fail = (code: number, error: string): HttpResponse => ({ status: code, ok: false, data: { error } });

  return async (request: HttpRequest): Promise<HttpResponse> => {
    const method = request.method ?? "GET";
    const path = new URL(request.url).pathname;
    if (request.headers?.Authorization !== `Bearer ${DEMO_AGENT_TOKEN}`) return fail(401, "missing or wrong token");

    if (path === "/api/v1/info") return ok({ version: "0.1.0-demo", ffmpeg: "ffmpeg version 6.1.1", mediamtx: true, startedAt: Math.floor(now() / 1000) });
    if (path === "/api/v1/play/config" && method === "GET") return ok(play);
    if (path === "/api/v1/play/config" && method === "PUT") {
      const next = request.body as PlayConfig;
      const problem = validatePlayConfig(next)[0];
      if (problem) return fail(422, `invalid configuration (${problem.code})`);
      play = { ...next, users: next.users.map((u) => ({ ...u, token: u.token || newToken() })) };
      return ok(play);
    }
    if (path === "/api/v1/play/clients" && method === "GET") return ok(playClients());
    if (path === "/api/v1/host" && method === "GET") return ok(hostView());
    if (path === "/api/v1/binaries" && method === "GET") return ok(binState());
    if (path === "/api/v1/binaries/mediamtx/latest") return ok({ version: newest() });
    if (path === "/api/v1/binaries/mediamtx/install" && method === "POST") {
      let version = (request.body as { version?: string }).version ?? "";
      if (version === "latest" || version === "") version = newest();
      if (!versionOf(version)) return fail(400, "the version must look like v1.21.4");
      if (version > "v1.21.5") return fail(502, "download failed: status 404");
      if (!bins.installed.includes(version)) bins.installed.push(version);
      return ok(binSnapshot());
    }
    if (path === "/api/v1/binaries/mediamtx/use" && method === "POST") {
      const version = (request.body as { version?: string }).version ?? "";
      if (!bins.installed.includes(version)) return fail(404, "that version is not installed");
      bins.current = version;
      if (bins.enabled) restartLog();
      return ok(binSnapshot());
    }
    const removal = /^\/api\/v1\/binaries\/mediamtx\/(v[^/]+)$/.exec(path);
    if (removal && method === "DELETE") {
      const version = decodeURIComponent(removal[1]!);
      if (version === bins.current) return fail(409, "that version is the one in use; switch to another first");
      if (!bins.installed.includes(version)) return fail(404, "that version is not installed");
      bins.installed = bins.installed.filter((v) => v !== version);
      return ok(binSnapshot());
    }
    if (path === "/api/v1/mediamtx/process" && method === "GET") return ok({ status: procStatus(), logs: [...procLogs] });
    const control = /^\/api\/v1\/mediamtx\/process\/(start|stop|restart)$/.exec(path);
    if (control && method === "POST") {
      if (control[1] === "stop") {
        bins.enabled = false;
        bins.running = false;
        procLogs.push("--- stopped");
      } else {
        bins.enabled = true;
        bins.running = true;
        restartLog();
      }
      return ok({ status: procStatus(), logs: [...procLogs] });
    }
    if (path === "/api/v1/mediamtx/config" && method === "GET") return ok(mtxState());
    if (path === "/api/v1/mediamtx/_paths") return ok(mtxPaths); // demo only
    if (path === "/api/v1/mediamtx/validate" && method === "POST") {
      const overlay = (request.body as { overlay?: string }).overlay ?? "";
      const problem = mtxProblem(overlay);
      return ok(problem ? { ok: false, error: problem } : { ok: true, merged: `# Generated by nodo-agent\napi: yes\n${overlay}` });
    }
    if (path === "/api/v1/mediamtx/config" && method === "PUT") {
      const overlay = (request.body as { overlay?: string }).overlay ?? "";
      const problem = mtxProblem(overlay);
      if (problem) return fail(422, problem);
      if (overlay !== mtx.overlay) mtx.prev = mtx.overlay;
      mtx.overlay = overlay;
      return ok(mtxState());
    }
    if (path === "/api/v1/mediamtx/undo" && method === "POST") {
      if (mtx.prev === null) return fail(409, "there is nothing to undo");
      mtx.overlay = mtx.prev;
      mtx.prev = null;
      return ok(mtxState());
    }
    if (path.startsWith("/api/v1/mediamtx/paths/") && ["PUT", "PATCH", "DELETE"].includes(method)) {
      const conf = (request.body as { conf?: Record<string, unknown> } | undefined)?.conf;
      if (method !== "DELETE" && !conf) return fail(400, "conf is required");
      if (conf && "badParam" in conf) return fail(422, `json: unknown field "badParam"`);
      mtxPaths.push(`${method} ${decodeURIComponent(path.slice("/api/v1/mediamtx/paths/".length))}`);
      return ok(null, 204);
    }
    if (path === "/api/v1/services" && method === "GET") return ok([...sims.values()].map(view));
    if (path === "/api/v1/services" && method === "POST") {
      const body = request.body as Partial<AgentService>;
      if (!body.name?.trim()) return fail(400, "name is required");
      const id = body.id || slug(body.name);
      if (sims.has(id)) return fail(409, "a service with that id already exists");
      const service = { ...(body as AgentService), id, enabled: body.enabled ?? true };
      const sim = start(service);
      sims.set(id, sim);
      return ok(view(sim), 201);
    }
    const match = /^\/api\/v1\/services\/([^/]+)(?:\/(enable|disable|switch))?$/.exec(path);
    if (!match) return fail(404, "not found");
    const id = decodeURIComponent(match[1]!);
    const sim = sims.get(id);
    if (!sim) return fail(404, "service not found");
    const action = match[2];

    if (!action && method === "GET") return ok(view(sim));
    if (!action && method === "DELETE") {
      sims.delete(id);
      return ok(null, 204);
    }
    if (!action && method === "PUT") {
      const body = request.body as AgentService;
      if (!body.name?.trim()) return fail(400, "name is required");
      sim.service = { ...body, id };
      sim.active = Math.min(sim.active, sim.service.inputs.length - 1);
      return ok(view(sim));
    }
    if (method === "POST" && (action === "enable" || action === "disable")) {
      sim.service = { ...sim.service, enabled: action === "enable" };
      if (action === "enable") Object.assign(sim, start(sim.service), { events: sim.events });
      sim.events.push({ at: new Date(now()).toISOString(), level: "info", message: action === "enable" ? "Servicio iniciado" : "Servicio detenido" });
      return ok(view(sim));
    }
    if (method === "POST" && action === "switch") {
      const input = (request.body as { input?: number } | undefined)?.input;
      if (typeof input !== "number" || input < 0 || input >= sim.service.inputs.length) return fail(400, `input ${input} does not exist`);
      if (!sim.service.enabled) return fail(400, "service is not running");
      if (input !== sim.active) {
        sim.active = input;
        sim.events.push({ at: new Date(now()).toISOString(), level: "info", message: `Entrada activa: ${input + 1} (cambio manual). La salida mantiene sus PIDs.` });
      }
      return ok(view(sim));
    }
    return fail(404, "not found");
  };
}
