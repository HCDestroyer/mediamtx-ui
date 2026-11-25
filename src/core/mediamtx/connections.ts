import { ApiError, listPaths, type ApiClient } from "./api";
import type { RawPath } from "./types";

/** Every kind of client connection MediaMTX v1.21 reports through its API. */
export type Proto = "rtsp" | "rtsps" | "rtmp" | "rtmps" | "srt" | "webrtc" | "hls";

interface ProtoSpec {
  proto: Proto;
  list: string;
  /** Path prefix of the kick call; the id is appended. */
  kick: string;
}

// RTSP is listed by session (a session carries the path); the TCP connection under it has none.
export const PROTOCOLS: readonly ProtoSpec[] = [
  { proto: "rtsp", list: "/v3/rtsp/sessions/list", kick: "/v3/rtsp/sessions/kick/" },
  { proto: "rtsps", list: "/v3/rtsps/sessions/list", kick: "/v3/rtsps/sessions/kick/" },
  { proto: "rtmp", list: "/v3/rtmp/conns/list", kick: "/v3/rtmp/conns/kick/" },
  { proto: "rtmps", list: "/v3/rtmps/conns/list", kick: "/v3/rtmps/conns/kick/" },
  { proto: "srt", list: "/v3/srt/conns/list", kick: "/v3/srt/conns/kick/" },
  { proto: "webrtc", list: "/v3/webrtc/sessions/list", kick: "/v3/webrtc/sessions/kick/" },
  { proto: "hls", list: "/v3/hls/sessions/list", kick: "/v3/hls/sessions/kick/" },
];

export type Role = "publisher" | "reader";

export interface Connection {
  /** Unique across protocols. */
  key: string;
  proto: Proto;
  id: string;
  /** Empty while the client has not chosen a path yet. */
  path: string;
  remoteAddr: string;
  user: string;
  /** Milliseconds since the epoch; 0 when unknown. */
  created: number;
  inBytes: number;
  outBytes: number;
  role: Role;
  /** SRT round-trip time in milliseconds. */
  rttMs?: number;
  /** SRT packet loss, percent of packets received. */
  lossPct?: number;
  /** RTSP transport (udp, tcp, multicast). */
  transport?: string;
}

type Raw = Record<string, unknown>;

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** v1.21 reports `inboundBytes`/`outboundBytes`; `bytesReceived`/`bytesSent` are the deprecated names. */
function bytes(raw: Raw, current: string, deprecated: string): number {
  return typeof raw[current] === "number" ? num(raw[current]) : num(raw[deprecated]);
}

/** Who feeds a path (`source.id`) and who reads it, so a connection can be told apart without guessing. */
export interface Roles {
  publishers: Set<string>;
  readers: Set<string>;
}

export function rolesFromPaths(paths: RawPath[]): Roles {
  const publishers = new Set<string>();
  const readers = new Set<string>();
  for (const p of paths) {
    if (p.source?.id) publishers.add(p.source.id);
    for (const r of p.readers ?? []) if (r.id) readers.add(r.id);
  }
  return { publishers, readers };
}

/** The paths list is authoritative; without it the direction of the traffic is the best guess. */
export function roleOf(id: string, inBytes: number, outBytes: number, roles: Roles): Role {
  if (roles.publishers.has(id)) return "publisher";
  if (roles.readers.has(id)) return "reader";
  return inBytes > outBytes ? "publisher" : "reader";
}

export function normalizeConnection(proto: Proto, raw: Raw, roles: Roles): Connection {
  const id = str(raw.id);
  const inBytes = bytes(raw, "inboundBytes", "bytesReceived");
  const outBytes = bytes(raw, "outboundBytes", "bytesSent");
  const created = Date.parse(str(raw.created));
  const conn: Connection = {
    key: `${proto}:${id}`,
    proto,
    id,
    path: str(raw.path),
    remoteAddr: str(raw.remoteAddr),
    user: str(raw.user),
    created: Number.isNaN(created) ? 0 : created,
    inBytes,
    outBytes,
    role: roleOf(id, inBytes, outBytes, roles),
  };
  if (proto === "srt") {
    if (typeof raw.msRTT === "number") conn.rttMs = raw.msRTT;
    const received = num(raw.packetsReceived);
    const lost = num(raw.packetsReceivedLoss);
    if (received + lost > 0) conn.lossPct = (100 * lost) / (received + lost);
  }
  if (proto === "rtsp" || proto === "rtsps") {
    const transport = str(raw.transport);
    if (transport) conn.transport = transport;
  }
  return conn;
}

export interface ConnectionList {
  connections: Connection[];
  /** Protocols whose list could not be read (disabled in MediaMTX or the call failed). */
  unavailable: Proto[];
}

interface Page {
  items?: Raw[];
  pageCount?: number;
}

/** Reads every protocol in parallel; one that fails does not hide the others. */
export async function listConnections(client: ApiClient): Promise<ConnectionList> {
  const [paths, results] = await Promise.all([
    listPaths(client).catch(() => [] as RawPath[]),
    Promise.all(
      PROTOCOLS.map(async (spec) => {
        try {
          const items: Raw[] = [];
          for (let page = 0; page < 20; page += 1) {
            const data = await client.get<Page>(`${spec.list}?page=${page}&itemsPerPage=500`);
            items.push(...(data.items ?? []));
            if (page + 1 >= (data.pageCount ?? 1)) break;
          }
          return { spec, items };
        } catch (error) {
          // Authentication problems apply to every call: surface them instead of showing "nothing connected".
          if (error instanceof ApiError && (error.status === 401 || error.status === 403)) throw error;
          return { spec, items: null };
        }
      }),
    ),
  ]);
  const roles = rolesFromPaths(paths);
  const connections: Connection[] = [];
  const unavailable: Proto[] = [];
  for (const { spec, items } of results) {
    if (!items) unavailable.push(spec.proto);
    else for (const raw of items) connections.push(normalizeConnection(spec.proto, raw, roles));
  }
  return { connections, unavailable };
}

export function kickConnection(client: ApiClient, conn: Pick<Connection, "proto" | "id">): Promise<unknown> {
  const spec = PROTOCOLS.find((p) => p.proto === conn.proto)!;
  return client.send("POST", `${spec.kick}${encodeURIComponent(conn.id)}`);
}
