import { useEffect } from "react";
import { create } from "zustand";
import { ChannelFeed, type FeedError, type ServerMeta, type Snapshot } from "../core/feed";
import type { Rate } from "../core/mediamtx/bitrate";
import type { Summary } from "../core/mediamtx/summary";
import type { Channel, RawPathConf } from "../core/mediamtx/types";
import type { Ports } from "../core/mediamtx/urls";
import { transportFor } from "../core/transport";
import { connectionOf, useConnection } from "./connection";
import { usePrefs } from "./prefs";
import { selectActiveServer, useServers } from "./servers";

export interface HistoryPoint {
  inMbps: number;
  outMbps: number;
  live: number;
  readers: number;
}

const HISTORY_LENGTH = 60;
const EMPTY_SUMMARY: Summary = { live: 0, total: 0, readers: 0, inMbps: 0, outMbps: 0 };

interface ChannelsState {
  /** `loading` until the first poll of the current server completes. */
  status: "loading" | "ready" | "error";
  error: FeedError | null;
  channels: Channel[];
  rates: Record<string, Rate | null>;
  summary: Summary;
  history: HistoryPoint[];
  updatedAt: number | null;
  version: string | null;
  ports: Ports | null;
  pathDefaults: RawPathConf | null;
}

const initial: ChannelsState = {
  status: "loading", error: null, channels: [], rates: {}, summary: EMPTY_SUMMARY,
  history: [], updatedAt: null, version: null, ports: null, pathDefaults: null,
};

export const useChannels = create<ChannelsState>()(() => initial);

function onSnapshot(snapshot: Snapshot): void {
  useChannels.setState((state) => {
    const hasRates = Object.values(snapshot.rates).some((r) => r !== null);
    const point: HistoryPoint = {
      inMbps: snapshot.summary.inMbps, outMbps: snapshot.summary.outMbps,
      live: snapshot.summary.live, readers: snapshot.summary.readers,
    };
    return {
      status: "ready", error: null, channels: snapshot.channels, rates: snapshot.rates,
      summary: snapshot.summary, updatedAt: snapshot.at,
      // The first poll has no rate yet; skip it so charts do not start with a false zero.
      history: hasRates || state.history.length > 0 ? [...state.history, point].slice(-HISTORY_LENGTH) : state.history,
    };
  });
}

let currentServerId: string | null = null;

/** The one feed shared by every screen that shows live channel data. */
export const channelFeed = new ChannelFeed(
  {
    onSnapshot,
    onMeta: (meta: ServerMeta) =>
      useChannels.setState({ version: meta.version, ports: meta.ports, pathDefaults: meta.pathDefaults }),
    onError: (error) =>
      useChannels.setState((state) => ({ error, status: state.updatedAt ? state.status : "error" })),
    onResult: (ok) => {
      const server = useServers.getState().servers.find((s) => s.id === currentServerId);
      if (server) useConnection.getState().reportRequest(server, ok);
    },
    onReset: () => useChannels.setState(initial),
  },
  {
    intervalMs: () => usePrefs.getState().pollIntervalMs,
    isHidden: () => document.hidden,
  },
);

if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) channelFeed.refresh();
  });
}

/**
 * Subscribes the calling screen to live channel data for the active server.
 * Several screens can use it at once; polling stops when none is mounted.
 */
export function useChannelsFeed() {
  const server = useServers(selectActiveServer);
  const connection = useConnection((s) => connectionOf(s.byServer, server?.id));
  const endpoint = connection.status === "online" ? connection.active?.endpoint.apiUrl : undefined;

  useEffect(() => {
    if (!server || !endpoint) {
      currentServerId = null;
      channelFeed.setTarget(null);
      return;
    }
    currentServerId = server.id;
    channelFeed.setTarget({
      serverId: server.id, baseUrl: endpoint, username: server.username, password: server.password,
      transport: transportFor(server),
    });
  }, [server, endpoint]);

  useEffect(() => channelFeed.subscribe(), []);

  return { server, connection, data: useChannels() };
}
