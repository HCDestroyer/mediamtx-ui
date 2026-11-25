/**
 * Minimal WHEP client (WebRTC-HTTP egress protocol), enough to watch a MediaMTX path:
 * POST an SDP offer, apply the answer, DELETE the session when done. Everything the browser provides
 * is injectable so the flow can be tested without a browser.
 */

export type WhepFailure = "unsupported" | "unavailable" | "unauthorized" | "network" | "server" | "ice";

export class WhepError extends Error {
  readonly kind: WhepFailure;
  /** Text the server answered with, when there is one. */
  readonly detail: string | null;
  constructor(kind: WhepFailure, message: string, detail: string | null = null) {
    super(message);
    this.name = "WhepError";
    this.kind = kind;
    this.detail = detail;
  }
}

export interface WhepOptions {
  /** `http(s)://host:8889/<path>/whep` */
  url: string;
  headers?: Record<string, string>;
  /** How long to wait for ICE candidates before sending the offer with what there is. */
  iceTimeoutMs?: number;
  requestTimeoutMs?: number;
  onStream: (stream: MediaStream) => void;
  /** Called with "failed" when the connection drops after it was established. */
  onState?: (state: "failed") => void;
  fetchImpl?: typeof fetch;
  PeerConnection?: typeof RTCPeerConnection;
}

export interface WhepSession {
  stop(): Promise<void>;
}

function waitForIce(pc: RTCPeerConnection, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    if (pc.iceGatheringState === "complete") return resolve();
    const done = () => {
      clearTimeout(timer);
      pc.removeEventListener("icegatheringstatechange", onChange);
      pc.removeEventListener("icecandidate", onCandidate);
      resolve();
    };
    const onChange = () => pc.iceGatheringState === "complete" && done();
    const onCandidate = (event: Event) => !(event as RTCPeerConnectionIceEvent).candidate && done();
    const timer = setTimeout(done, timeoutMs);
    pc.addEventListener("icegatheringstatechange", onChange);
    pc.addEventListener("icecandidate", onCandidate);
  });
}

export async function startWhep(options: WhepOptions): Promise<WhepSession> {
  const Peer = options.PeerConnection ?? (typeof RTCPeerConnection === "undefined" ? undefined : RTCPeerConnection);
  if (!Peer) throw new WhepError("unsupported", "This browser has no WebRTC");
  const doFetch = options.fetchImpl ?? fetch.bind(globalThis);

  // No STUN/TURN: a LAN or VPN server is reachable directly, and a public one has a public address.
  const pc = new Peer({ iceServers: [] });
  const fail = (error: WhepError): never => {
    pc.close();
    throw error;
  };

  try {
    pc.addTransceiver("video", { direction: "recvonly" });
    pc.addTransceiver("audio", { direction: "recvonly" });
    let delivered = false;
    pc.addEventListener("track", (event) => {
      const stream = event.streams[0] ?? new MediaStream([event.track]);
      if (!delivered) {
        delivered = true;
        options.onStream(stream);
      }
    });
    pc.addEventListener("connectionstatechange", () => {
      if (pc.connectionState === "failed" || pc.connectionState === "disconnected") options.onState?.("failed");
    });

    await pc.setLocalDescription(await pc.createOffer());
    await waitForIce(pc, options.iceTimeoutMs ?? 2000);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.requestTimeoutMs ?? 8000);
    let response: Response;
    try {
      response = await doFetch(options.url, {
        method: "POST",
        headers: { "Content-Type": "application/sdp", ...options.headers },
        body: pc.localDescription?.sdp ?? "",
        signal: controller.signal,
      });
    } catch {
      return fail(new WhepError("network", "Could not reach the server"));
    } finally {
      clearTimeout(timer);
    }

    if (response.status === 404) return fail(new WhepError("unavailable", "The channel is not available", await safeText(response)));
    if (response.status === 401 || response.status === 403) return fail(new WhepError("unauthorized", "Not allowed to watch", await safeText(response)));
    if (!response.ok) return fail(new WhepError("server", `HTTP ${response.status}`, await safeText(response)));

    const session = response.headers.get("Location");
    const answer = await response.text();
    try {
      await pc.setRemoteDescription({ type: "answer", sdp: answer });
    } catch {
      return fail(new WhepError("server", "The server sent an answer the browser cannot use"));
    }

    let stopped = false;
    return {
      async stop() {
        if (stopped) return;
        stopped = true;
        pc.close();
        if (session) {
          // Tells the server to free the session now instead of waiting for it to time out.
          await doFetch(new URL(session, options.url).toString(), { method: "DELETE", headers: options.headers }).catch(() => undefined);
        }
      },
    };
  } catch (error) {
    if (error instanceof WhepError) throw error;
    pc.close();
    throw new WhepError("server", error instanceof Error ? error.message : "WebRTC failed");
  }
}

async function safeText(response: Response): Promise<string | null> {
  try {
    const text = (await response.text()).trim();
    return text ? text.slice(0, 300) : null;
  } catch {
    return null;
  }
}
