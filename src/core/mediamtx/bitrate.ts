export interface ByteSample {
  bytesIn: number;
  bytesOut: number;
}

export interface Rate {
  inMbps: number;
  outMbps: number;
}

/** Shorter gaps between polls are too noisy to turn into a rate. */
const MIN_INTERVAL_MS = 200;

/**
 * Turns the byte counters of consecutive polls into Mbps. The first sample of a
 * channel has no previous one, so its rate is `null`; a counter that goes
 * backwards (publisher reconnected) counts as zero for that interval.
 */
export class BitrateTracker {
  private previous = new Map<string, ByteSample & { at: number }>();

  update(samples: ReadonlyMap<string, ByteSample>, now: number): Map<string, Rate | null> {
    const rates = new Map<string, Rate | null>();
    const next = new Map<string, ByteSample & { at: number }>();
    for (const [name, sample] of samples) {
      const prev = this.previous.get(name);
      if (prev && now - prev.at >= MIN_INTERVAL_MS) {
        const seconds = (now - prev.at) / 1000;
        const mbps = (delta: number) => (Math.max(0, delta) * 8) / seconds / 1e6;
        rates.set(name, {
          inMbps: mbps(sample.bytesIn - prev.bytesIn),
          outMbps: mbps(sample.bytesOut - prev.bytesOut),
        });
        next.set(name, { ...sample, at: now });
      } else if (prev) {
        // Too soon: keep the older baseline so the next rate spans a full interval.
        rates.set(name, null);
        next.set(name, prev);
      } else {
        rates.set(name, null);
        next.set(name, { ...sample, at: now });
      }
    }
    this.previous = next;
    return rates;
  }

  reset(): void {
    this.previous.clear();
  }
}
