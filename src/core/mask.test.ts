import { describe, expect, it } from "vitest";
import { maskUrlSecrets } from "./mask";

describe("maskUrlSecrets", () => {
  it("is applied to source URLs shown on screen", () => {
    expect(maskUrlSecrets("srt://10.0.0.5:9000?streamid=read:cam&passphrase=0123456789")).toBe(
      "srt://10.0.0.5:9000?streamid=read:cam&passphrase=••••••••",
    );
    expect(maskUrlSecrets("rtsp://admin:hunter2@192.168.1.60/stream1")).toBe("rtsp://admin:••••••••@192.168.1.60/stream1");
    expect(maskUrlSecrets("udp+mpegts://239.255.1.1:1234")).toBe("udp+mpegts://239.255.1.1:1234");
  });
});
