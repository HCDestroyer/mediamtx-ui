import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDemoTransport, DEMO_API_URL } from "./demo";
import { ChannelFeed, type FeedCallbacks, type FeedTarget } from "./feed";
import { TransportError, type Transport } from "./http";

const target = (transport: Transport, serverId = "s1"): FeedTarget => ({
  serverId, baseUrl: DEMO_API_URL, username: "", password: "", transport,
});

function setup(transport: Transport) {
  const log = { snapshots: [] as Array<Parameters<FeedCallbacks["onSnapshot"]>[0]>, errors: [] as string[], results: [] as boolean[], meta: [] as unknown[], resets: 0 };
  let now = 1_700_000_000_000;
  const feed = new ChannelFeed(
    {
      onSnapshot: (s) => log.snapshots.push(s),
      onMeta: (m) => log.meta.push(m),
      onError: (e) => log.errors.push(e),
      onResult: (ok) => log.results.push(ok),
      onReset: () => { log.resets += 1; },
    },
    { intervalMs: () => 2000, now: () => now, isHidden: () => false },
  );
  const advance = async (ms: number) => {
    now += ms;
    await vi.advanceTimersByTimeAsync(ms);
  };
  feed.setTarget(target(transport));
  return { feed, log, advance };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("ChannelFeed", () => {
  it("does nothing without subscribers", async () => {
    const { log, advance } = setup(createDemoTransport());
    await advance(10_000);
    expect(log.snapshots).toHaveLength(0);
  });

  it("polls on an interval and computes bitrates from the second poll", async () => {
    const { feed, log, advance } = setup(createDemoTransport());
    feed.subscribe();
    await advance(1);
    expect(log.snapshots).toHaveLength(1);
    expect(log.snapshots[0]?.rates.canal63).toBeNull();
    expect(log.snapshots[0]?.summary).toMatchObject({ live: 3, total: 5 });

    await advance(2000);
    expect(log.snapshots).toHaveLength(2);
    const second = log.snapshots[1]!;
    expect(second.rates.canal63?.inMbps).toBeGreaterThan(2);
    expect(second.summary.readers).toBe(7);
    expect(second.summary.inMbps).toBeGreaterThan(5);
    expect(log.results.every(Boolean)).toBe(true);
  });

  it("loads version and ports once", async () => {
    const { feed, log, advance } = setup(createDemoTransport());
    feed.subscribe();
    await advance(6000);
    expect(log.meta).toHaveLength(1);
    expect(log.meta[0]).toMatchObject({
      version: "v1.21.4", ports: { rtsp: { port: 8554 }, srt: { port: 8890 } }, pathDefaults: { source: "publisher" },
    });
  });

  it("stops when the last subscriber leaves", async () => {
    const { feed, log, advance } = setup(createDemoTransport());
    const unsubscribe = feed.subscribe();
    await advance(1);
    unsubscribe();
    const count = log.snapshots.length;
    await advance(10_000);
    expect(log.snapshots).toHaveLength(count);
  });

  it("resets state when the target server changes", async () => {
    const { feed, log, advance } = setup(createDemoTransport());
    feed.subscribe();
    await advance(1);
    const resets = log.resets;
    feed.setTarget(target(createDemoTransport(), "s2"));
    expect(log.resets).toBe(resets + 1);
    await advance(1);
    expect(log.snapshots.at(-1)?.rates.canal63).toBeNull();
  });

  it("reports network failures as failed requests", async () => {
    const down: Transport = async () => { throw new TransportError("network", "down"); };
    const { feed, log, advance } = setup(down);
    feed.subscribe();
    await advance(4001);
    expect(log.errors.length).toBeGreaterThanOrEqual(2);
    expect(new Set(log.errors)).toEqual(new Set(["unreachable"]));
    expect(log.results.every((ok) => ok === false)).toBe(true);
  });

  it("reports a rejected login without counting it as a network failure", async () => {
    const unauthorized: Transport = async () => ({ status: 401, ok: false, data: null });
    const { feed, log, advance } = setup(unauthorized);
    feed.subscribe();
    await advance(1);
    expect(log.errors).toEqual(["auth"]);
    expect(log.results).toEqual([true]);
  });

  it("recovers after a failure", async () => {
    const demo = createDemoTransport();
    let fail = true;
    const flaky: Transport = async (r) => { if (fail) throw new TransportError("timeout", "t"); return demo(r); };
    const { feed, log, advance } = setup(flaky);
    feed.subscribe();
    await advance(1);
    expect(log.errors).toHaveLength(1);
    fail = false;
    await advance(2000);
    expect(log.snapshots).toHaveLength(1);
  });
});
