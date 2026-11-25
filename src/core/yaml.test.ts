import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { maskUrlSecrets, minimalPathConf, pathsToYaml, toYaml } from "./yaml";

const roundTrip = (value: unknown) => parse(toYaml(value));

describe("toYaml", () => {
  it("round-trips scalars, tricky strings, arrays and nesting through a real YAML parser", () => {
    const value = {
      plain: "publisher",
      url: "srt://127.0.0.1:3333?passphrase=abc&streamid=x",
      command: 'ffmpeg -i "rtsp://127.0.0.1:8554/a" -vf scale=-2:720 -f rtsp x',
      empty: "",
      leadingDash: "-2:720",
      reserved: ["yes", "no", "null", "true", "~", "on"],
      numbers: ["123", "1.5", "0x10", "1e3"],
      realNumbers: [1, 2.5, 0],
      flags: [true, false],
      nothing: null,
      unicode: "ñandú ✓",
      multiline: "line1\nline2",
      hash: "a #b",
      colon: "a: b",
      list: [{ dest: "rtmps://x/live#KEY", destFingerprint: "" }, { dest: "rtmp://y/app" }],
      nested: { a: { b: { c: 1 } } },
      emptyArray: [],
      emptyObject: {},
    };
    expect(roundTrip(value)).toEqual(value);
  });

  it("indents lists of objects the way mediamtx.yml does", () => {
    expect(toYaml({ forward: [{ dest: "rtmp://a", moqTransport: "quic" }] })).toBe(
      "forward:\n  - dest: \"rtmp://a\"\n    moqTransport: quic\n",
    );
  });
});

describe("minimalPathConf", () => {
  const defaults = { source: "publisher", record: false, recordFormat: "fmp4", runOnOnline: "", forward: [], maxReaders: 0 };

  it("keeps only what differs from the defaults, source first, never name or nulls", () => {
    const conf = {
      name: "canal63", record: true, recordFormat: "fmp4", runOnOnline: "ffmpeg", runOnReady: null,
      source: "srt://h:1", forward: [], maxReaders: 0,
    };
    expect(Object.entries(minimalPathConf(conf, defaults))).toEqual([
      ["source", "srt://h:1"], ["record", true], ["runOnOnline", "ffmpeg"],
    ]);
  });

  it("returns the whole configuration when there are no defaults", () => {
    expect(minimalPathConf({ name: "a", source: "publisher", record: false }, null)).toEqual({ source: "publisher", record: false });
  });
});

describe("pathsToYaml", () => {
  const defaults = { source: "publisher", record: false, runOnOnline: "" };
  const confs = [
    { name: "canal63", source: "srt://h:1?passphrase=0123456789&streamid=x", srtReadPassphrase: "secretsecret", record: true },
    { name: "canal63_720", source: "publisher" },
    { name: "all_others", source: "publisher" },
  ];

  it("produces a paths section a YAML parser reads back", () => {
    const text = pathsToYaml(confs, { defaults, header: "Exported by Nodo" });
    expect(text.startsWith("# Exported by Nodo\npaths:\n")).toBe(true);
    expect(parse(text)).toEqual({
      paths: {
        canal63: { source: "srt://h:1?passphrase=0123456789&streamid=x", srtReadPassphrase: "secretsecret", record: true },
        canal63_720: {},
        all_others: {},
      },
    });
  });

  it("masks credentials for the on-screen preview but not for the export", () => {
    const masked = pathsToYaml(confs, { defaults, mask: true });
    expect(masked).not.toContain("0123456789");
    expect(masked).not.toContain("secretsecret");
    expect(pathsToYaml(confs, { defaults })).toContain("secretsecret");
  });
});

describe("maskUrlSecrets", () => {
  it("hides passwords, passphrases and stream keys", () => {
    expect(maskUrlSecrets("rtsp://user:pass@cam/x")).toBe("rtsp://user:••••••••@cam/x");
    expect(maskUrlSecrets("srt://h:1?streamid=x&passphrase=0123456789&latency=1")).toBe("srt://h:1?streamid=x&passphrase=••••••••&latency=1");
    expect(maskUrlSecrets("rtmps://a.example/live2#abcd-1234")).toBe("rtmps://a.example/live2#••••••••");
    expect(maskUrlSecrets("rtsp://cam/x")).toBe("rtsp://cam/x");
  });
});
