import { describe, expect, it, vi } from "vitest";
import { startWhep, WhepError } from "./whep";

/** Enough of RTCPeerConnection for the protocol: records what it was asked and fires events by hand. */
class FakePeer {
  static last: FakePeer;
  iceGatheringState: RTCIceGatheringState = "complete";
  connectionState: RTCPeerConnectionState = "new";
  localDescription: { sdp: string } | null = null;
  remote: { type: string; sdp: string } | null = null;
  closed = false;
  transceivers: string[] = [];
  failRemote = false;
  private listeners = new Map<string, Array<(e: never) => void>>();
  constructor(public config: unknown) {
    FakePeer.last = this;
  }
  addTransceiver(kind: string, init: { direction: string }) {
    this.transceivers.push(`${kind}:${init.direction}`);
  }
  async createOffer() {
    return { type: "offer", sdp: "OFFER" };
  }
  async setLocalDescription(d: { sdp: string }) {
    this.localDescription = d;
  }
  async setRemoteDescription(d: { type: string; sdp: string }) {
    if (this.failRemote) throw new Error("bad sdp");
    this.remote = d;
  }
  addEventListener(type: string, fn: (e: never) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  removeEventListener(type: string, fn: (e: never) => void) {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter((f) => f !== fn));
  }
  emit(type: string, event: unknown) {
    for (const fn of this.listeners.get(type) ?? []) fn(event as never);
  }
  close() {
    this.closed = true;
  }
}

const Peer = FakePeer as unknown as typeof RTCPeerConnection;

function response(status: number, body = "", headers: Record<string, string> = {}) {
  return new Response(body, { status, headers });
}

const base = { url: "http://10.0.0.2:8889/canal63/whep", onStream: () => {}, PeerConnection: Peer };

describe("startWhep", () => {
  it("offers receive-only audio and video, posts the SDP and applies the answer", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return response(201, "ANSWER", { Location: "/canal63/whep/abc" });
    }) as unknown as typeof fetch;
    await startWhep({ ...base, headers: { Authorization: "Basic xyz" }, fetchImpl });
    expect(FakePeer.last.transceivers).toEqual(["video:recvonly", "audio:recvonly"]);
    expect(FakePeer.last.config).toEqual({ iceServers: [] });
    expect(calls[0]!.url).toBe("http://10.0.0.2:8889/canal63/whep");
    expect(calls[0]!.init.method).toBe("POST");
    expect(calls[0]!.init.body).toBe("OFFER");
    expect(calls[0]!.init.headers).toEqual({ "Content-Type": "application/sdp", Authorization: "Basic xyz" });
    expect(FakePeer.last.remote).toEqual({ type: "answer", sdp: "ANSWER" });
  });

  it("delivers the stream once and releases the session on stop", async () => {
    const calls: string[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push(`${init.method} ${url}`);
      return init.method === "POST" ? response(201, "ANSWER", { Location: "/canal63/whep/abc" }) : response(200);
    }) as unknown as typeof fetch;
    const onStream = vi.fn();
    const session = await startWhep({ ...base, onStream, fetchImpl });
    const stream = { id: "s" } as MediaStream;
    FakePeer.last.emit("track", { streams: [stream], track: {} });
    FakePeer.last.emit("track", { streams: [stream], track: {} }); // the audio track arrives too
    expect(onStream).toHaveBeenCalledTimes(1);
    expect(onStream).toHaveBeenCalledWith(stream);
    await session.stop();
    await session.stop();
    expect(FakePeer.last.closed).toBe(true);
    expect(calls).toEqual(["POST http://10.0.0.2:8889/canal63/whep", "DELETE http://10.0.0.2:8889/canal63/whep/abc"]);
  });

  it("maps HTTP failures to what the user can act on, and closes the connection", async () => {
    const cases: Array<[number, string]> = [[404, "unavailable"], [401, "unauthorized"], [403, "unauthorized"], [500, "server"]];
    for (const [status, kind] of cases) {
      const fetchImpl = (async () => response(status, "denied")) as unknown as typeof fetch;
      const error = await startWhep({ ...base, fetchImpl }).catch((e) => e);
      expect(error).toBeInstanceOf(WhepError);
      expect(error.kind).toBe(kind);
      expect(FakePeer.last.closed).toBe(true);
    }
  });

  it("reports an unreachable server as a network failure", async () => {
    const fetchImpl = (async () => { throw new TypeError("Failed to fetch"); }) as unknown as typeof fetch;
    const error = await startWhep({ ...base, fetchImpl }).catch((e) => e);
    expect(error.kind).toBe("network");
    expect(FakePeer.last.closed).toBe(true);
  });

  it("rejects an answer the browser cannot use", async () => {
    const fetchImpl = (async () => response(201, "garbage")) as unknown as typeof fetch;
    const failing = class extends FakePeer {
      override failRemote = true;
    } as unknown as typeof RTCPeerConnection;
    const error = await startWhep({ ...base, PeerConnection: failing, fetchImpl }).catch((e) => e);
    expect(error.kind).toBe("server");
  });

  it("says so when the browser has no WebRTC", async () => {
    const error = await startWhep({ ...base, PeerConnection: undefined, fetchImpl: fetch }).catch((e) => e);
    // jsdom-less node has no RTCPeerConnection either, so the default path is the unsupported one.
    expect(error.kind).toBe("unsupported");
  });

  it("does not wait forever for ICE", async () => {
    const slow = class extends FakePeer {
      override iceGatheringState: RTCIceGatheringState = "gathering";
    } as unknown as typeof RTCPeerConnection;
    const fetchImpl = (async () => response(201, "ANSWER")) as unknown as typeof fetch;
    const started = Date.now();
    await startWhep({ ...base, PeerConnection: slow, fetchImpl, iceTimeoutMs: 30 });
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("tells the caller when an established connection drops", async () => {
    const fetchImpl = (async () => response(201, "ANSWER")) as unknown as typeof fetch;
    const onState = vi.fn();
    await startWhep({ ...base, fetchImpl, onState });
    FakePeer.last.connectionState = "failed";
    FakePeer.last.emit("connectionstatechange", {});
    expect(onState).toHaveBeenCalledWith("failed");
  });
});
