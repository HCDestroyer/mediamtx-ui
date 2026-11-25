import { BitrateTracker, type Rate } from "./mediamtx/bitrate";
import {
  ApiError, createApiClient, getGlobalConfig, getInfo, getPathDefaults, listPathConfs, listPaths, type ApiClient,
} from "./mediamtx/api";
import { mergeChannels, normalizePath } from "./mediamtx/normalize";
import { summarize, type Summary } from "./mediamtx/summary";
import type { Channel, RawPathConf } from "./mediamtx/types";
import { readPorts, type Ports } from "./mediamtx/urls";
import type { Transport } from "./http";

export interface FeedTarget {
  /** Identifies the server so a change of server resets all state. */
  serverId: string;
  baseUrl: string;
  username: string;
  password: string;
  transport: Transport;
}

export interface Snapshot {
  channels: Channel[];
  rates: Record<string, Rate | null>;
  summary: Summary;
  at: number;
}

export interface ServerMeta {
  version: string | null;
  ports: Ports | null;
  /** `/v3/config/path-defaults/get`: tells which hook names the server knows and what a new path inherits. */
  pathDefaults: RawPathConf | null;
}

export type FeedError = "auth" | "unreachable";

export interface FeedCallbacks {
  onSnapshot(snapshot: Snapshot): void;
  onMeta(meta: ServerMeta): void;
  onError(error: FeedError): void;
  /** Called with every request outcome so the connection can re-resolve after repeated failures. */
  onResult(ok: boolean): void;
  onReset(): void;
}

export interface FeedOptions {
  intervalMs: () => number;
  now?: () => number;
  isHidden?: () => boolean;
  /** The configured-paths list changes rarely; it is refreshed every N polls. */
  confEvery?: number;
}

/**
 * Polls `/v3/paths/list` and turns it into channels, bitrates and totals.
 * Runs only while it has a target and at least one subscriber.
 * Framework-free so it can be tested with fake timers.
 */
export class ChannelFeed {
  private target: FeedTarget | null = null;
  private subscribers = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private generation = 0;
  private tracker = new BitrateTracker();
  private confs: RawPathConf[] | null = null;
  private metaLoaded = false;
  private ticks = 0;

  constructor(
    private readonly callbacks: FeedCallbacks,
    private readonly options: FeedOptions,
  ) {}

  setTarget(target: FeedTarget | null): void {
    const changed =
      this.target?.serverId !== target?.serverId ||
      this.target?.baseUrl !== target?.baseUrl ||
      this.target?.username !== target?.username ||
      this.target?.password !== target?.password;
    this.target = target;
    if (!changed) return;
    this.generation += 1;
    this.tracker.reset();
    this.confs = null;
    this.metaLoaded = false;
    this.ticks = 0;
    this.callbacks.onReset();
    this.restart();
  }

  subscribe(): () => void {
    this.subscribers += 1;
    this.restart();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.subscribers -= 1;
      this.restart();
    };
  }

  /**
   * Polls immediately, for example when the tab becomes visible again.
   * `confs` also reloads the configured-paths list, which otherwise refreshes every few polls.
   */
  refresh(options: { confs?: boolean } = {}): void {
    if (options.confs) this.confs = null;
    if (this.timer) this.restart();
  }

  private restart(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.running = Boolean(this.target) && this.subscribers > 0;
    if (this.running) this.timer = setTimeout(() => void this.loop(this.generation), 0);
  }

  private async loop(generation: number): Promise<void> {
    if (!this.running || generation !== this.generation || !this.target) return;
    if (!this.options.isHidden?.()) await this.tick(this.target, generation);
    if (!this.running || generation !== this.generation) return;
    this.timer = setTimeout(() => void this.loop(generation), this.options.intervalMs());
  }

  private async tick(target: FeedTarget, generation: number): Promise<void> {
    const client: ApiClient = createApiClient({
      baseUrl: target.baseUrl, username: target.username, password: target.password, transport: target.transport,
    });
    const now = this.options.now ?? Date.now;
    try {
      const runtime = await listPaths(client);
      if (this.confs === null || this.ticks % (this.options.confEvery ?? 5) === 0) {
        // A user without permission to read the config still gets the runtime list.
        this.confs = await listPathConfs(client).catch(() => this.confs);
      }
      this.ticks += 1;
      if (generation !== this.generation) return;

      const channels = mergeChannels(runtime.map(normalizePath), this.confs);
      const live = new Map(
        runtime.map((p) => [p.name, { bytesIn: p.inboundBytes ?? p.bytesReceived ?? 0, bytesOut: p.outboundBytes ?? p.bytesSent ?? 0 }]),
      );
      const rates = this.tracker.update(live, now());
      const ratesByName = Object.fromEntries(rates);
      this.callbacks.onResult(true);
      this.callbacks.onSnapshot({ channels, rates: ratesByName, summary: summarize(channels, rates), at: now() });

      if (!this.metaLoaded) {
        this.metaLoaded = true;
        void this.loadMeta(client, generation);
      }
    } catch (error) {
      if (generation !== this.generation) return;
      const auth = error instanceof ApiError && (error.status === 401 || error.status === 403);
      // A rejected login is not a network failure, so it must not trigger re-resolving.
      this.callbacks.onResult(auth);
      this.callbacks.onError(auth ? "auth" : "unreachable");
    }
  }

  private async loadMeta(client: ApiClient, generation: number): Promise<void> {
    try {
      const [conf, info, pathDefaults] = await Promise.all([
        getGlobalConfig(client),
        getInfo(client).catch(() => null),
        getPathDefaults(client).catch(() => null),
      ]);
      if (generation === this.generation) {
        this.callbacks.onMeta({ version: info?.version ?? null, ports: readPorts(conf), pathDefaults });
      }
    } catch {
      // Try again on the next poll.
      if (generation === this.generation) this.metaLoaded = false;
    }
  }
}
