import { describe, expect, it } from "vitest";
import {
  buildCreate, buildPatch, confToForm, detectHookKeys, EMPTY_FORM, formToConf, getSourcePassphrase,
  setSourcePassphrase, sourceMode, validateForm, validatePassphrase, validatePathName, type PathForm,
} from "./pathConf";

const modern = detectHookKeys({ runOnOnline: "", source: "publisher" });
const legacy = detectHookKeys({ runOnReady: "", source: "publisher" });

describe("hook keys", () => {
  it("uses runOnOnline on servers that have it and runOnReady on older ones", () => {
    expect(modern).toEqual({ command: "runOnOnline", restart: "runOnOnlineRestart" });
    expect(legacy).toEqual({ command: "runOnReady", restart: "runOnReadyRestart" });
    expect(detectHookKeys(null)).toEqual(legacy);
  });
});

describe("source", () => {
  it("classifies the source", () => {
    expect(sourceMode("publisher")).toBe("publisher");
    expect(sourceMode("")).toBe("publisher");
    expect(sourceMode(undefined)).toBe("publisher");
    expect(sourceMode("rtsp://cam/stream")).toBe("url");
    expect(sourceMode("srt://127.0.0.1:3333?streamid=x")).toBe("url");
    expect(sourceMode("udp+mpegts://239.255.1.1:1234")).toBe("url");
    expect(sourceMode("rtsp+ws://cam/x")).toBe("url");
    expect(sourceMode("redirect")).toBe("other");
    expect(sourceMode("rpiCamera")).toBe("other");
  });

  it("reads and writes the SRT passphrase without touching the rest of the URL", () => {
    const url = "srt://127.0.0.1:3333?streamid=read:canal&passphrase=abc%20defghij&latency=200";
    expect(getSourcePassphrase(url)).toBe("abc defghij");
    expect(setSourcePassphrase(url, "")).toBe("srt://127.0.0.1:3333?streamid=read:canal&latency=200");
    expect(setSourcePassphrase("srt://h:1", "p@ss word 12")).toBe("srt://h:1?passphrase=p%40ss%20word%2012");
    expect(setSourcePassphrase("srt://h:1?streamid=x", "0123456789")).toBe("srt://h:1?streamid=x&passphrase=0123456789");
    expect(setSourcePassphrase("srt://h:1?passphrase=old1234567", "new1234567")).toBe("srt://h:1?passphrase=new1234567");
    expect(getSourcePassphrase("srt://h:1")).toBe("");
  });
});

describe("confToForm / formToConf", () => {
  const conf = {
    source: "srt://127.0.0.1:3333?passphrase=0123456789&streamid=x",
    sourceOnDemand: true,
    srtReadPassphrase: "readpass-123",
    runOnOnline: "ffmpeg -i x",
    runOnOnlineRestart: true,
    record: true,
    recordFormat: "mpegts",
    recordSegmentDuration: "30m",
    recordDeleteAfter: "7d",
    recordPath: "./rec/%path",
  };

  it("splits the SRT passphrase out of the URL and recombines it", () => {
    const form = confToForm("canal63", conf, modern);
    expect(form).toMatchObject({
      name: "canal63", sourceMode: "url", sourceUrl: "srt://127.0.0.1:3333?streamid=x",
      sourcePassphrase: "0123456789", sourceOnDemand: true, hookCommand: "ffmpeg -i x", hookRestart: true,
      record: true, recordFormat: "mpegts",
    });
    expect(formToConf(form, modern)).toMatchObject({
      source: "srt://127.0.0.1:3333?streamid=x&passphrase=0123456789",
      runOnOnline: "ffmpeg -i x", runOnOnlineRestart: true, recordSegmentDuration: "30m",
    });
  });

  it("round-trips without producing changes", () => {
    const form = confToForm("canal63", { ...conf, source: "srt://127.0.0.1:3333?streamid=x&passphrase=0123456789" }, modern);
    expect(buildPatch({ ...conf, source: "srt://127.0.0.1:3333?streamid=x&passphrase=0123456789" }, form, modern)).toEqual({});
  });

  it("defaults to a publisher path with recording off", () => {
    const form = confToForm("x", {}, legacy);
    expect(form).toMatchObject({ sourceMode: "publisher", record: false, hookCommand: "", recordFormat: "fmp4" });
  });

  it("keeps redirect and rpiCamera sources as they are", () => {
    const form = confToForm("x", { source: "redirect" }, modern);
    expect(form.sourceMode).toBe("other");
    expect(formToConf(form, modern).source).toBe("redirect");
  });

  it("does not request on-demand for a publisher source", () => {
    expect(formToConf({ ...EMPTY_FORM, sourceOnDemand: true }, modern).sourceOnDemand).toBe(false);
  });
});

describe("patch and create bodies", () => {
  const original = { source: "publisher", record: false, runOnOnline: "", srtReadPassphrase: "" };
  const form = (overrides: Partial<PathForm>): PathForm => ({ ...confToForm("x", original, modern), ...overrides });

  it("PATCH sends only the fields that changed", () => {
    expect(buildPatch(original, form({ record: true }), modern)).toEqual({ record: true });
    expect(buildPatch(original, form({ hookCommand: "ffmpeg", hookRestart: true }), modern)).toEqual({
      runOnOnline: "ffmpeg", runOnOnlineRestart: true,
    });
  });

  it("PATCH clears a field by sending an empty string", () => {
    const withHook = { ...original, runOnOnline: "ffmpeg" };
    expect(buildPatch(withHook, form({ hookCommand: "" }), modern)).toEqual({ runOnOnline: "" });
  });

  it("POST sends only what differs from the defaults", () => {
    const defaults = { source: "publisher", record: false, recordFormat: "fmp4", recordPath: EMPTY_FORM.recordPath,
      recordSegmentDuration: "1h", recordDeleteAfter: "1d" };
    expect(buildCreate(EMPTY_FORM, modern, defaults)).toEqual({});
    expect(buildCreate({ ...EMPTY_FORM, sourceMode: "url", sourceUrl: "rtsp://cam/x" }, modern, defaults)).toEqual({
      source: "rtsp://cam/x",
    });
  });
});

describe("validation", () => {
  it("validates path names", () => {
    for (const ok of ["canal63", "canal_63-b", "cams/patio.1", "~^cam(\\d+)$", "all_others"]) expect(validatePathName(ok)).toBeNull();
    expect(validatePathName("")).toBe("name-required");
    expect(validatePathName("  ")).toBe("name-required");
    for (const bad of ["a b", "/lead", "trail/", "a//b", "ñandú", "a?b", "~"]) expect(validatePathName(bad)).toBe(bad === "~" ? "name-invalid" : "name-invalid");
  });

  it("requires SRT passphrases of 10 to 79 characters, or none", () => {
    expect(validatePassphrase("")).toBeNull();
    expect(validatePassphrase("123456789")).toBe("passphrase-length");
    expect(validatePassphrase("1234567890")).toBeNull();
    expect(validatePassphrase("x".repeat(79))).toBeNull();
    expect(validatePassphrase("x".repeat(80))).toBe("passphrase-length");
  });

  it("flags every problem of a form at once", () => {
    const errors = validateForm(
      { ...EMPTY_FORM, name: "bad name", sourceMode: "url", sourceUrl: "ftp://x",
        srtPublishPassphrase: "short", record: true, recordPath: " ", recordSegmentDuration: "soon", recordDeleteAfter: "1d" },
      { creating: true },
    );
    expect(errors).toEqual({
      name: "name-invalid", sourceUrl: "source-invalid", srtPublishPassphrase: "passphrase-length",
      recordPath: "record-path-required", recordSegmentDuration: "duration-invalid",
    });
  });

  it("checks the SRT source passphrase only for srt:// sources", () => {
    const base = { ...EMPTY_FORM, name: "a", sourceMode: "url" as const, sourcePassphrase: "short" };
    expect(validateForm({ ...base, sourceUrl: "srt://h:1" }, { creating: true }).sourcePassphrase).toBe("passphrase-length");
    expect(validateForm({ ...base, sourceUrl: "rtsp://h/x" }, { creating: true }).sourcePassphrase).toBeUndefined();
  });

  it("rejects an existing name only when creating", () => {
    const form = { ...EMPTY_FORM, name: "canal63" };
    expect(validateForm(form, { creating: true, existingNames: ["canal63"] }).name).toBe("name-exists");
    expect(validateForm(form, { creating: false, existingNames: ["canal63"] }).name).toBeUndefined();
  });

  it("ignores recording fields while recording is off", () => {
    expect(validateForm({ ...EMPTY_FORM, name: "a", recordPath: "", recordDeleteAfter: "x" }, { creating: true })).toEqual({});
  });
});
