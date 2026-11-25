import { describe, expect, it } from "vitest";
import {
  destinationFromKey, forwardKind, FORWARD_PRESETS, maskDestination, readForwardList, splitDestination,
  validateDestination,
} from "./forward";

describe("forward destinations", () => {
  it("recognizes the protocol", () => {
    expect(forwardKind("rtmps://a.example/live2#key")).toBe("RTMP");
    expect(forwardKind("rtmp://a.example/app")).toBe("RTMP");
    expect(forwardKind("srt://host:9000?streamid=publish:x")).toBe("SRT");
    expect(forwardKind("rtsp://user:pass@host/x")).toBe("RTSP");
    expect(forwardKind("whips://host/x/whip")).toBe("WHIP");
    expect(forwardKind("http://host")).toBeNull();
  });

  it("validates", () => {
    expect(validateDestination("")).toBe("required");
    expect(validateDestination("  ")).toBe("required");
    expect(validateDestination("http://x")).toBe("scheme");
    expect(validateDestination("rtmp://")).toBe("host");
    expect(validateDestination("rtmps://a.example/live2#abc")).toBeNull();
    expect(validateDestination("srt://10.0.0.5:9000?streamid=x")).toBeNull();
  });

  it("joins and splits platform URL and stream key", () => {
    const dest = destinationFromKey("rtmps://a.rtmps.youtube.com:443/live2", " abcd-1234 ");
    expect(dest).toBe("rtmps://a.rtmps.youtube.com:443/live2#abcd-1234");
    expect(splitDestination(dest)).toEqual({ base: "rtmps://a.rtmps.youtube.com:443/live2", key: "abcd-1234" });
    expect(splitDestination("srt://h:1")).toEqual({ base: "srt://h:1", key: "" });
  });

  it("has presets for YouTube, Facebook, Twitch and a custom one", () => {
    expect(FORWARD_PRESETS.map((p) => p.id)).toEqual(["youtube", "facebook", "twitch", "custom"]);
    for (const preset of FORWARD_PRESETS.filter((p) => p.base)) {
      expect(validateDestination(destinationFromKey(preset.base, "key"))).toBeNull();
    }
  });

  it("never shows passwords, passphrases or stream keys", () => {
    expect(maskDestination("rtmps://a.example/live2#abcd-1234")).toBe("rtmps://a.example/live2#••••");
    expect(maskDestination("rtsp://user:secret@host/x")).toBe("rtsp://user:••••@host/x");
    expect(maskDestination("srt://h:1?streamid=x&passphrase=0123456789")).toBe("srt://h:1?streamid=x&passphrase=••••");
    expect(maskDestination("srt://h:1?streamid=x")).toBe("srt://h:1?streamid=x");
  });

  it("reads the list defensively", () => {
    expect(readForwardList(undefined)).toEqual([]);
    expect(readForwardList([{ dest: "rtmp://a" }, { dest: "" }, null, 5, { x: 1 }])).toEqual([{ dest: "rtmp://a" }]);
  });
});
