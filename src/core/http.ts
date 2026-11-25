/**
 * Transport abstraction. The web build uses `fetch`; the Android build swaps
 * in a CapacitorHttp-based transport (phase 5) so CORS and mixed content do
 * not apply. Everything else in the app talks to this module only.
 */

export type HttpMethod = "GET" | "POST" | "PATCH" | "DELETE";

export interface HttpRequest {
  url: string;
  method?: HttpMethod;
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs?: number;
}

export interface HttpResponse<T = unknown> {
  status: number;
  ok: boolean;
  data: T;
}

export type TransportErrorKind = "timeout" | "network" | "mixed-content";

export class TransportError extends Error {
  readonly kind: TransportErrorKind;
  constructor(kind: TransportErrorKind, message: string) {
    super(message);
    this.name = "TransportError";
    this.kind = kind;
  }
}

export type Transport = (request: HttpRequest) => Promise<HttpResponse>;

const DEFAULT_TIMEOUT_MS = 8000;

export const fetchTransport: Transport = async (request) => {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    request.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );
  try {
    const headers: Record<string, string> = { ...request.headers };
    let body: string | undefined;
    if (request.body !== undefined) {
      body = JSON.stringify(request.body);
      headers["Content-Type"] ??= "application/json";
    }
    const response = await fetch(request.url, {
      method: request.method ?? "GET",
      headers,
      body,
      signal: controller.signal,
      cache: "no-store",
    });
    const text = await response.text();
    let data: unknown = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    }
    return { status: response.status, ok: response.ok, data };
  } catch (error) {
    if (controller.signal.aborted) {
      throw new TransportError("timeout", "Request timed out");
    }
    throw new TransportError(
      "network",
      error instanceof Error ? error.message : "Network error",
    );
  } finally {
    clearTimeout(timer);
  }
};

let currentTransport: Transport = fetchTransport;

export function setTransport(transport: Transport): void {
  currentTransport = transport;
}

export function getTransport(): Transport {
  return currentTransport;
}

/** Basic Auth header value; UTF-8 safe. */
export function basicAuthHeader(username: string, password: string): string {
  const bytes = new TextEncoder().encode(`${username}:${password}`);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `Basic ${btoa(binary)}`;
}

/**
 * Adds `http://` when the scheme is missing and strips trailing slashes.
 * Returns an empty string for blank input.
 */
export function normalizeApiUrl(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return "";
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
    ? trimmed
    : `http://${trimmed}`;
  return withScheme.replace(/\/+$/, "");
}

export function isValidApiUrl(input: string): boolean {
  try {
    const url = new URL(normalizeApiUrl(input));
    return (url.protocol === "http:" || url.protocol === "https:") && !!url.hostname;
  } catch {
    return false;
  }
}

/**
 * A page served over HTTPS cannot call an `http://` API (mixed content).
 * The Android build uses native HTTP, so it passes `pageProtocol: "capacitor:"`
 * or overrides the check entirely.
 */
export function isMixedContentBlocked(
  apiUrl: string,
  pageProtocol: string | undefined = typeof location === "undefined"
    ? undefined
    : location.protocol,
): boolean {
  return pageProtocol === "https:" && apiUrl.toLowerCase().startsWith("http://");
}
