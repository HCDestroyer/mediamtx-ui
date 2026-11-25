import { describe, expect, it } from "vitest";
import { readerLabel, sourceLabel } from "./labels";

describe("labels", () => {
  it("translates known types and passes unknown ones through", () => {
    expect(sourceLabel("srtSource")).toBe("SRT (extrae)");
    expect(sourceLabel("rtmpConn")).toBe("RTMP (publicador)");
    expect(sourceLabel("somethingNew")).toBe("somethingNew");
    expect(readerLabel("webRTCSession")).toBe("WebRTC");
    expect(readerLabel("x")).toBe("x");
  });
});
