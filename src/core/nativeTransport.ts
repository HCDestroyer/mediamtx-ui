import { TransportError, type HttpRequest, type HttpResponse, type Transport } from "./http";

/** The part of Capacitor's `CapacitorHttp` plugin the transport uses; injectable for tests. */
export interface NativeHttp {
  request(options: {
    url: string;
    method: string;
    headers?: Record<string, string>;
    data?: unknown;
    readTimeout?: number;
    connectTimeout?: number;
    responseType?: "json" | "text";
  }): Promise<{ status: number; data: unknown }>;
}

const DEFAULT_TIMEOUT_MS = 8000;

/**
 * Transport for the Android app: requests are made by the native HTTP stack, so the WebView's CORS and
 * mixed-content rules do not apply (a LAN MediaMTX on http:// is the normal case).
 */
export function createNativeTransport(http: NativeHttp): Transport {
  return async (request: HttpRequest): Promise<HttpResponse> => {
    const timeout = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const headers: Record<string, string> = { ...request.headers };
    if (request.body !== undefined) headers["Content-Type"] ??= "application/json";
    try {
      const response = await http.request({
        url: request.url,
        method: request.method ?? "GET",
        headers,
        data: request.body,
        connectTimeout: timeout,
        readTimeout: timeout,
      });
      const data = normalize(response.data);
      return { status: response.status, ok: response.status >= 200 && response.status < 300, data };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new TransportError(/time(d)? ?out/i.test(message) ? "timeout" : "network", message);
    }
  };
}

/** The plugin parses JSON itself; an empty body arrives as "" and plain text as a string. */
function normalize(data: unknown): unknown {
  if (data === "" || data === undefined) return null;
  if (typeof data === "string") {
    try {
      return JSON.parse(data);
    } catch {
      return data;
    }
  }
  return data;
}
