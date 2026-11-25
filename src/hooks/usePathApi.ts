import { useMemo } from "react";
import { AgentError } from "../core/agent/api";
import { createApiClient, type ApiClient, ApiError } from "../core/mediamtx/api";
import { mirrorWrites, type PathMirror } from "../core/mediamtx/mirror";
import { detectHookKeys, type HookKeys } from "../core/mediamtx/pathConf";
import type { RawPathConf } from "../core/mediamtx/types";
import { transportFor } from "../core/transport";
import { toast } from "@heroui/react";
import { t } from "../i18n/es";
import { channelFeed, useChannels } from "../store/channels";
import { useUnsaved } from "../store/unsaved";
import { useActiveServer } from "./useActiveConnection";
import { useActiveAgent } from "./useAgentClient";

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
  const agent = useActiveAgent().client;

  return useMemo(() => {
    const live =
      server && baseUrl
        ? createApiClient({
            baseUrl, username: server.username, password: server.password, transport: transportFor(server),
          })
        : null;
    // With an agent that manages the additional file, every path change is also kept there.
    const mirror: PathMirror | undefined = agent
      ? {
          set: (name, conf) => agent.mtxPathSet(name, conf),
          patch: (name, conf) => agent.mtxPathPatch(name, conf),
          remove: (name) => agent.mtxPathRemove(name),
        }
      : undefined;
    const tracked = live
      ? mirrorWrites(live, mirror, (error) => {
          // 404 only means this agent does not manage the file: the "unsaved" banner already says so.
          if (error instanceof AgentError && error.status === 404) return;
          toast.warning(t.config.notPersisted, {
            description: error instanceof AgentError && error.detail ? error.detail : t.config.notPersistedWhy,
          });
        })
      : null;
    const client = tracked?.client ?? null;
    return {
      client,
      serverId: server?.id ?? null,
      hook: detectHookKeys(pathDefaults),
      pathDefaults,
      rtspPort: ports?.rtsp.port ?? 8554,
      wrote: () => {
        // A change kept in the additional file survives a restart; any other one is lost until exported.
        const outcome = tracked?.take();
        if (server && !outcome?.mirrored) useUnsaved.getState().markUnsaved(server.id);
        channelFeed.refresh({ confs: true });
      },
    };
  }, [server, baseUrl, pathDefaults, ports, agent]);
}

/** Message to show for a failed API call, preferring the text the server sent. */
export function apiErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiError && error.detail) return error.detail;
  return fallback;
}
