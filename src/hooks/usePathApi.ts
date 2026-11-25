import { useMemo } from "react";
import { createApiClient, type ApiClient, ApiError } from "../core/mediamtx/api";
import { detectHookKeys, type HookKeys } from "../core/mediamtx/pathConf";
import type { RawPathConf } from "../core/mediamtx/types";
import { transportFor } from "../core/transport";
import { channelFeed, useChannels } from "../store/channels";
import { useUnsaved } from "../store/unsaved";
import { useActiveServer } from "./useActiveConnection";

export interface PathApi {
  /** Null while the server is not connected. */
  client: ApiClient | null;
  serverId: string | null;
  /** Hook names this server understands (`runOnOnline` on v1.21, `runOnReady` before). */
  hook: HookKeys;
  pathDefaults: RawPathConf | null;
  rtspPort: number;
  /** Call after every successful write: flags the config as unsaved and refreshes the lists. */
  wrote: () => void;
}

/** Client and context for changing path configuration on the active server. */
export function usePathApi(): PathApi {
  const { server, connection } = useActiveServer();
  const pathDefaults = useChannels((s) => s.pathDefaults);
  const ports = useChannels((s) => s.ports);
  const baseUrl = connection.status === "online" ? connection.active?.endpoint.apiUrl : undefined;

  return useMemo(() => {
    const client =
      server && baseUrl
        ? createApiClient({
            baseUrl, username: server.username, password: server.password, transport: transportFor(server),
          })
        : null;
    return {
      client,
      serverId: server?.id ?? null,
      hook: detectHookKeys(pathDefaults),
      pathDefaults,
      rtspPort: ports?.rtsp.port ?? 8554,
      wrote: () => {
        // The demo server behaves like a real one: its changes are not "saved" anywhere either.
        if (server) useUnsaved.getState().markUnsaved(server.id);
        channelFeed.refresh({ confs: true });
      },
    };
  }, [server, baseUrl, pathDefaults, ports]);
}

/** Message to show for a failed API call, preferring the text the server sent. */
export function apiErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiError && error.detail) return error.detail;
  return fallback;
}
