import type { ApiClient, WriteMethod } from "./api";

/** Keeps a path of the configuration in the agent's additional file (so it survives a MediaMTX restart). */
export interface PathMirror {
  set(name: string, conf: Record<string, unknown>): Promise<void>;
  patch(name: string, conf: Record<string, unknown>): Promise<void>;
  remove(name: string): Promise<void>;
}

export interface MirroredClient {
  client: ApiClient;
  /** Returns what happened since the last call and starts counting again. */
  take(): { writes: number; mirrored: boolean };
}

const PATH_WRITE = /^\/v3\/config\/paths\/(add|replace|patch|delete)\/(.+)$/;

/**
 * Wraps a MediaMTX API client: after every successful change of a path it repeats the change in the
 * additional file through `mirror`. The live change always comes first; a failure to mirror it never
 * undoes it, it only means the change is not persisted (`mirrored` is false).
 */
export function mirrorWrites(
  inner: ApiClient,
  mirror: PathMirror | undefined,
  onMirrorError?: (error: unknown) => void,
): MirroredClient {
  let writes = 0;
  let failed = false;

  const client: ApiClient = {
    get: (path) => inner.get(path),
    async send<T>(method: WriteMethod, path: string, body?: unknown): Promise<T> {
      const result = await inner.send<T>(method, path, body);
      const match = PATH_WRITE.exec(path);
      if (!match) return result;
      writes += 1;
      if (!mirror) {
        failed = true;
        return result;
      }
      const op = match[1]!;
      const name = match[2]!.split("/").map(decodeURIComponent).join("/");
      const conf = (body ?? {}) as Record<string, unknown>;
      try {
        if (op === "delete") await mirror.remove(name);
        else if (op === "patch") await mirror.patch(name, conf);
        else await mirror.set(name, conf);
      } catch (error) {
        failed = true;
        onMirrorError?.(error);
      }
      return result;
    },
  };

  return {
    client,
    take() {
      const out = { writes, mirrored: writes > 0 && !failed };
      writes = 0;
      failed = false;
      return out;
    },
  };
}
