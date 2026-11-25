import { useEffect } from "react";
import { connectionOf, useConnection, type Connection } from "../store/connection";
import { selectActiveServer, useServers } from "../store/servers";
import type { Server } from "../core/types";

/** Stable key that changes only when connection-relevant fields change. */
function signature(server: Server): string {
  return JSON.stringify([server.endpoints, server.username, server.password]);
}

/**
 * Keeps the active server connected: resolves its endpoint on start and
 * whenever its address or credentials change, and re-checks it periodically.
 * Mount once, near the root.
 */
export function useConnectionManager(): void {
  const server = useServers(selectActiveServer);
  const connect = useConnection((s) => s.connect);
  const disconnect = useConnection((s) => s.disconnect);
  const key = server ? `${server.id}:${signature(server)}` : "";

  useEffect(() => {
    if (!server) return;
    void connect(server);
    return () => disconnect(server.id);
    // `key` captures every field `connect` depends on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
}

export function useActiveServer(): { server: Server | undefined; connection: Connection } {
  const server = useServers(selectActiveServer);
  const connection = useConnection((s) => connectionOf(s.byServer, server?.id));
  return { server, connection };
}
