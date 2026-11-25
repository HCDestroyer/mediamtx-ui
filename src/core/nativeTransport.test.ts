import { describe, expect, it, vi } from "vitest";
import { TransportError } from "./http";
import { createNativeTransport, type NativeHttp } from "./nativeTransport";

const make = (impl: NativeHttp["request"]) => {
  const request = vi.fn(impl);
  return { request, transport: createNativeTransport({ request }) };
};

describe("native transport", () => {
  it("passes method, headers and JSON body to the native stack with the timeout", async () => {
    const { transport, request } = make(async () => ({ status: 200, data: { ok: true } }));
    const out = await transport({ url: "http://10.0.0.2:9997/v3/x", method: "PATCH", headers: { Authorization: "Basic a" }, body: { a: 1 }, timeoutMs: 3000 });
    expect(out).toEqual({ status: 200, ok: true, data: { ok: true } });
    expect(request).toHaveBeenCalledWith({
      url: "http://10.0.0.2:9997/v3/x", method: "PATCH", headers: { Authorization: "Basic a", "Content-Type": "application/json" },
      data: { a: 1 }, connectTimeout: 3000, readTimeout: 3000,
    });
  });

  it("defaults to GET and does not invent a content type without a body", async () => {
    const { transport, request } = make(async () => ({ status: 200, data: [] }));
    await transport({ url: "http://h/x" });
    const call = request.mock.calls[0]![0];
    expect(call.method).toBe("GET");
    expect(call.headers).toEqual({});
  });

  it("reports HTTP errors as responses, not exceptions", async () => {
    const { transport } = make(async () => ({ status: 401, data: { error: "no" } }));
    expect(await transport({ url: "u" })).toEqual({ status: 401, ok: false, data: { error: "no" } });
  });

  it("normalizes empty and textual bodies", async () => {
    expect((await make(async () => ({ status: 200, data: "" })).transport({ url: "u" })).data).toBeNull();
    expect((await make(async () => ({ status: 200, data: '{"a":1}' })).transport({ url: "u" })).data).toEqual({ a: 1 });
    expect((await make(async () => ({ status: 200, data: "plain text" })).transport({ url: "u" })).data).toBe("plain text");
  });

  it("maps native failures to timeout or network errors", async () => {
    const timeout = await make(async () => { throw new Error("java.net.SocketTimeoutException: Read timed out"); }).transport({ url: "u" }).catch((e) => e);
    expect(timeout).toBeInstanceOf(TransportError);
    expect(timeout.kind).toBe("timeout");
    const refused = await make(async () => { throw new Error("Failed to connect to /10.0.0.2:9997"); }).transport({ url: "u" }).catch((e) => e);
    expect(refused.kind).toBe("network");
  });
});
