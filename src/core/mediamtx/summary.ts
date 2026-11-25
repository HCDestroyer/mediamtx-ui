import type { Rate } from "./bitrate";
import type { Channel } from "./types";

export interface Summary {
  live: number;
  total: number;
  readers: number;
  inMbps: number;
  outMbps: number;
}

export function summarize(channels: readonly Channel[], rates: ReadonlyMap<string, Rate | null>): Summary {
  let inMbps = 0;
  let outMbps = 0;
  for (const channel of channels) {
    const rate = rates.get(channel.name);
    if (rate) {
      inMbps += rate.inMbps;
      outMbps += rate.outMbps;
    }
  }
  return {
    live: channels.filter((c) => c.live).length,
    total: channels.length,
    readers: channels.reduce((sum, c) => sum + c.readerCount, 0),
    inMbps,
    outMbps,
  };
}
