import { describe, expect, it } from "vitest";
import { buildReadUrls, hostOf, parsePort, readPorts } from "./urls";

const defaults = {
  rtsp: true, rtspAddress: ":8554", rtspsAddress: ":8322", rtspEncryption: "no",
  rtmp: true, rtmpAddress: ":1935", rtmpsAddress: ":1936", rtmpEncryption: "no",
  srt: true, srtAddress: ":8890",
  hls: true, hlsAddress: ":8888", hlsEncryption: false,
  webrtc: true, webrtcAddress: ":8889", webrtcEncryption: false,
};

const urls = (conf: Record<string, unknown>, channel = "canal63") =>
  Object.fromEntries(buildReadUrls("192.168.1.20", channel, readPorts(conf)).map((u) => [u.protocol, u.url]));

describe("parsePort", () => {
  it("handles the address forms MediaMTX uses", () => {
    expect(parsePort(":8554")).toBe(8554);
    expect(parsePort("0.0.0.0:8554")).toBe(8554);
    expect(parsePort("[::]:8554")).toBe(8554);
    expect(parsePort("127.0.0.1:9997")).toBe(9997);
  });

  it("rejects anything else", () => {
    expect(parsePort("")).toBeNull();
    expect(parsePort(undefined)).toBeNull();
    expect(parsePort(":0")).toBeNull();
    expect(parsePort(":99999")).toBeNull();
    expect(parsePort("localhost")).toBeNull();
  });
});

describe("buildReadUrls", () => {
  it("uses the ports of the global config", () => {
    expect(urls(defaults)).toEqual({
      rtsp: "rtsp://192.168.1.20:8554/canal63",
      rtmp: "rtmp://192.168.1.20:1935/canal63",
      srt: "srt://192.168.1.20:8890?streamid=read:canal63",
      hls: "http://192.168.1.20:8888/canal63/index.m3u8",
      webrtc: "http://192.168.1.20:8889/canal63",
    });
  });

  it("follows custom ports", () => {
    const result = urls({ ...defaults, rtspAddress: "0.0.0.0:9554", hlsAddress: ":9888" });
    expect(result.rtsp).toBe("rtsp://192.168.1.20:9554/canal63");
    expect(result.hls).toBe("http://192.168.1.20:9888/canal63/index.m3u8");
  });

  it("leaves out disabled protocols", () => {
    const result = urls({ ...defaults, rtmp: false, srt: false });
    expect(Object.keys(result)).toEqual(["rtsp", "hls", "webrtc"]);
  });

  it("switches to the TLS variants when the server requires them", () => {
    const result = urls({ ...defaults, rtspEncryption: "strict", rtmpEncryption: "strict", hlsEncryption: true, webrtcEncryption: true });
    expect(result.rtsp).toBe("rtsps://192.168.1.20:8322/canal63");
    expect(result.rtmp).toBe("rtmps://192.168.1.20:1936/canal63");
    expect(result.hls).toBe("https://192.168.1.20:8888/canal63/index.m3u8");
    expect(result.webrtc).toBe("https://192.168.1.20:8889/canal63");
  });

  it("keeps plain URLs when TLS is optional", () => {
    expect(urls({ ...defaults, rtspEncryption: "optional" }).rtsp).toBe("rtsp://192.168.1.20:8554/canal63");
  });

  it("encodes channel names but keeps slashes", () => {
    expect(urls(defaults, "cams/patio 1").rtsp).toBe("rtsp://192.168.1.20:8554/cams/patio%201");
    expect(urls(defaults, "cams/patio 1").srt).toBe("srt://192.168.1.20:8890?streamid=read:cams/patio%201");
  });

  it("extracts the host from API URLs, including IPv6", () => {
    expect(hostOf("http://10.8.0.2:9997")).toBe("10.8.0.2");
    expect(hostOf("https://panel.example.net")).toBe("panel.example.net");
    expect(hostOf("http://[fd00::2]:9997")).toBe("[fd00::2]");
    expect(hostOf("nonsense")).toBe("");
  });
});
