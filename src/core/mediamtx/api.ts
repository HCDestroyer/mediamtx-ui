import { basicAuthHeader, getTransport, type Transport } from "../http";
import type { RawGlobalConf, RawInfo, RawPage, RawPath, RawPathConf } from "./types";

export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

export interface ApiClientOptions {
  baseUrl: string;
  username: string;
  password: string;
  transport?: Transport;
  timeoutMs?: number;
}

export interface ApiClient {
  get<T>(path: string): Promise<T>;
}

export function createApiClient(options: ApiClientOptions): ApiClient {
  const authorization = basicAuthHeader(options.username, options.password);
  return {
    async get<T>(path: string): Promise<T> {
      const transport = options.transport ?? getTransport();
      const response = await transport({
        url: `${options.baseUrl}${path}`,
        headers: { Authorization: authorization },
        timeoutMs: options.timeoutMs,
      });
      if (!response.ok) throw new ApiError(response.status, `HTTP ${response.status} on ${path}`);
      return response.data as T;
    },
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
