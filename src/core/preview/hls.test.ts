import { describe, expect, it, vi } from "vitest";
import { failureFromStatus, startHls } from "./hls";

describe("failureFromStatus", () => {
  it("maps the HTTP status to a failure the user understands", () => {
    expect(failureFromStatus(404)).toBe("unavailable");
    expect(failureFromStatus(401)).toBe("unauthorized");
    expect(failureFromStatus(403)).toBe("unauthorized");
    expect(failureFromStatus(500)).toBe("network");
    expect(failureFromStatus(undefined)).toBe("network");
  });
});

function fakeHls(supported = true) {
  const handlers = new Map<string, (e: string, d: unknown) => void>();
  const instances: Array<{ destroyed: boolean; src: string; xhrSetup?: (x: XMLHttpRequest) => void }> = [];
  class Hls {
    static Events = { ERROR: "hlsError" };
    static ErrorTypes = { MEDIA_ERROR: "mediaError", NETWORK_ERROR: "networkError" };
    static isSupported = () => supported;
    static emit(data: unknown) { handlers.get("hlsError")?.("hlsError", data); }
    state = { destroyed: false, src: "", xhrSetup: undefined as undefined | ((x: XMLHttpRequest) => void) };
    constructor(config: { xhrSetup?: (x: XMLHttpRequest) => void }) {
      this.state.xhrSetup = config.xhrSetup;
      instances.push(this.state);
    }
    on(event: string, fn: (e: string, d: unknown) => void) { handlers.set(event, fn); }
    loadSource(src: string) { this.state.src = src; }
    attachMedia() {}
    destroy() { this.state.destroyed = true; }
  }
  return { Hls, instances, loadHls: async () => ({ default: Hls as never }) };
}

const video = () => ({ addEventListener: vi.fn(), play: vi.fn(async () => undefined), canPlayType: vi.fn(() => ""), removeAttribute: vi.fn(), load: vi.fn() }) as unknown as HTMLVideoElement;

describe("startHls", () => {
  it("loads the playlist with the credentials on every request and cleans up", async () => {
    const f = fakeHls();
    const stop = await startHls({ video: video(), url: "http://h:8888/c/index.m3u8", headers: { Authorization: "Basic abc" }, onError: () => {}, loadHls: f.loadHls });
    expect(f.instances[0]!.src).toBe("http://h:8888/c/index.m3u8");
    const xhr = { setRequestHeader: vi.fn() };
    f.instances[0]!.xhrSetup!(xhr as never);
    expect(xhr.setRequestHeader).toHaveBeenCalledWith("Authorization", "Basic abc");
    stop();
    expect(f.instances[0]!.destroyed).toBe(true);
  });

  it("reports fatal errors with the right meaning and ignores recoverable ones", async () => {
    const f = fakeHls();
    const onError = vi.fn();
    await startHls({ video: video(), url: "u", onError, loadHls: f.loadHls });
    (f.Hls as unknown as { emit(d: unknown): void }).emit({ fatal: false, type: "networkError" });
    expect(onError).not.toHaveBeenCalled();
    (f.Hls as unknown as { emit(d: unknown): void }).emit({ fatal: true, type: "networkError", response: { code: 404 } });
    expect(onError).toHaveBeenLastCalledWith("unavailable");
    expect(f.instances[0]!.destroyed).toBe(true);
    (f.Hls as unknown as { emit(d: unknown): void }).emit({ fatal: true, type: "mediaError" });
    expect(onError).toHaveBeenLastCalledWith("media");
  });

  it("uses native HLS when hls.js is not supported and no credentials are needed", async () => {
    const f = fakeHls(false);
    const el = video();
    (el.canPlayType as ReturnType<typeof vi.fn>).mockReturnValue("maybe");
    await startHls({ video: el, url: "http://h/c.m3u8", onError: () => {}, loadHls: f.loadHls });
    expect(el.src).toBe("http://h/c.m3u8");
  });

  it("refuses native HLS when credentials are needed, because the browser cannot send them", async () => {
    const f = fakeHls(false);
    const el = video();
    (el.canPlayType as ReturnType<typeof vi.fn>).mockReturnValue("maybe");
    await expect(startHls({ video: el, url: "u", headers: { Authorization: "x" }, onError: () => {}, loadHls: f.loadHls })).rejects.toMatchObject({ kind: "unsupported" });
  });
});
