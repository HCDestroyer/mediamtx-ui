export type EndpointType = "lan" | "vpn" | "public";

/** Order in which endpoints are tried by the resolver. */
export const ENDPOINT_ORDER: readonly EndpointType[] = ["lan", "vpn", "public"];

export interface Endpoint {
  type: EndpointType;
  /** Base URL of the MediaMTX Control API, e.g. `http://192.168.1.20:9997`. */
  apiUrl: string;
}

export interface Server {
  id: string;
  name: string;
  /** Hex color shown next to the server name. */
  color: string;
  endpoints: Endpoint[];
  username: string;
  password: string;
}

export type ServerDraft = Omit<Server, "id">;

export const SERVER_COLORS = [
  "#2b62e6",
  "#12805c",
  "#8a5cf6",
  "#d98a00",
  "#c42b2b",
  "#0e7490",
] as const;
