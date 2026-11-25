import { basicAuthHeader, getTransport, type Transport } from "../http";
import type { RawGlobalConf, RawInfo, RawPage, RawPath, RawPathConf } from "./types";

export class ApiError extends Error {
  readonly status: number;
  /** Message sent by the server (`{"error": "..."}`), when there is one. */
  readonly detail: string | null;
  constructor(status: number, message: string, detail: string | null = null) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.detail = detail;
  }
}

export type WriteMethod = "POST" | "PATCH" | "DELETE";

export interface ApiClientOptions {
  baseUrl: string;
  username: string;
  password: string;
  transport?: Transport;
  timeoutMs?: number;
}

export interface ApiClient {
  get<T>(path: string): Promise<T>;
  send<T = unknown>(method: WriteMethod, path: string, body?: unknown): Promise<T>;
}

function errorDetail(data: unknown): string | null {
  if (data && typeof data === "object" && "error" in data && typeof data.error === "string") return data.error;
  return typeof data === "string" && data ? data : null;
}

export function createApiClient(options: ApiClientOptions): ApiClient {
  const authorization = basicAuthHeader(options.username, options.password);
  const call = async <T>(method: "GET" | WriteMethod, path: string, body?: unknown): Promise<T> => {
    const transport = options.transport ?? getTransport();
    const response = await transport({
      url: `${options.baseUrl}${path}`,
      method,
      headers: { Authorization: authorization },
      body,
      timeoutMs: options.timeoutMs,
    });
    if (!response.ok) {
      throw new ApiError(response.status, `HTTP ${response.status} on ${method} ${path}`, errorDetail(response.data));
    }
    return response.data as T;
  };
  return {
    get: <T>(path: string) => call<T>("GET", path),
    send: <T = unknown>(method: WriteMethod, path: string, body?: unknown) => call<T>(method, path, body),
  };
}

const PAGE_SIZE = 500;
const MAX_PAGES = 50;

/** Reads every page of a list endpoint. */
export async function fetchAllPages<T>(client: ApiClient, path: string): Promise<T[]> {
  const items: T[] = [];
  const separator = path.includes("?") ? "&" : "?";
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const data = await client.get<RawPage<T>>(`${path}${separator}page=${page}&itemsPerPage=${PAGE_SIZE}`);
    items.push(...(data.items ?? []));
    if (page + 1 >= (data.pageCount ?? 1)) break;
  }
  return items;
}

export const listPaths = (client: ApiClient) => fetchAllPages<RawPath>(client, "/v3/paths/list");
export const listPathConfs = (client: ApiClient) => fetchAllPages<RawPathConf>(client, "/v3/config/paths/list");
export const getGlobalConfig = (client: ApiClient) => client.get<RawGlobalConf>("/v3/config/global/get");

/** `/v3/info` does not exist on older servers; a 404 is reported as `null`. */
export async function getInfo(client: ApiClient): Promise<RawInfo | null> {
  try {
    return await client.get<RawInfo>("/v3/info");
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  }
}

/** Encodes a path name for the URL, keeping the slashes of names such as `cams/patio`. */
export const encodePathName = (name: string): string => name.split("/").map(encodeURIComponent).join("/");

export const getPathDefaults = (client: ApiClient) => client.get<RawPathConf>("/v3/config/path-defaults/get");
export const getPathConf = (client: ApiClient, name: string) =>
  client.get<RawPathConf>(`/v3/config/paths/get/${encodePathName(name)}`);
export const addPathConf = (client: ApiClient, name: string, conf: Record<string, unknown>) =>
  client.send("POST", `/v3/config/paths/add/${encodePathName(name)}`, conf);
export const patchPathConf = (client: ApiClient, name: string, conf: Record<string, unknown>) =>
  client.send("PATCH", `/v3/config/paths/patch/${encodePathName(name)}`, conf);
export const deletePathConf = (client: ApiClient, name: string) =>
  client.send("DELETE", `/v3/config/paths/delete/${encodePathName(name)}`);

export interface RawForwardDest {
  id?: string;
  pos?: number;
  type?: string;
  state?: "idle" | "forwarding" | "error";
  lastError?: string;
  outboundBytes?: number;
}
export const listForwardDests = (client: ApiClient, path: string) =>
  fetchAllPages<RawForwardDest>(client, `/v3/paths/forward-dests/list?path=${encodeURIComponent(path)}`);
