import { describe, expect, it } from "vitest";
import {
  checkAddress, DEFAULT_STREAMS, EMPTY_SERVICE_FORM, formToService, hasErrors, serviceToForm, validateServiceForm,
  type ServiceForm,
} from "./form";

const valid = (over: Partial<ServiceForm> = {}): ServiceForm => ({
  ...EMPTY_SERVICE_FORM,
  name: "Deportes HD",
  inputs: [{ url: "udp://eth0@239.255.1.1:1234#pnr=100", timeoutSec: "" }, { url: "mediamtx://respaldo", timeoutSec: "8" }],
  outputs: [{ url: "udp://239.255.10.1:1234#ttl=32" }],
  streams: DEFAULT_STREAMS.map((s) => ({ ...s })),
  ...over,
});

describe("form <-> service", () => {
  it("builds the JSON the agent expects", () => {
    const service = formToService(valid({ provider: "Nodo", cbrKbps: "4000" }));
    expect(service).toEqual({
      name: "Deportes HD", enabled: true,
      inputs: [{ url: "udp://eth0@239.255.1.1:1234#pnr=100" }, { url: "mediamtx://respaldo", timeoutSec: 8 }],
      backup: { mode: "active", returnDelaySec: 30 },
      profile: {
        serviceId: 100, pmtPid: 4096, name: "Deportes HD", provider: "Nodo", cbrKbps: 4000,
        streams: [
          { pid: 256, kind: "video" },
          { pid: 257, kind: "audio", lang: "spa", fallbackAny: true },
          { pid: 258, kind: "audio", lang: "eng" },
        ],
      },
      outputs: [{ url: "udp://239.255.10.1:1234#ttl=32" }],
    });
  });

  it("round-trips an existing service", () => {
    const original = { id: "deportes-hd", ...formToService(valid()) } as ReturnType<typeof formToService> & { id: string };
    const back = formToService(serviceToForm(original as never));
    expect(back).toEqual(original);
  });

  it("omits the id for a new service and lowercases languages", () => {
    const f = valid();
    f.streams[1]!.lang = "SPA";
    const s = formToService(f);
    expect(s).not.toHaveProperty("id");
    expect(s.profile.streams[1]?.lang).toBe("spa");
  });
});

describe("addresses", () => {
  it("accepts the types the agent supports", () => {
    for (const ok of ["udp://239.1.1.1:1234", "udp://eth0@239.1.1.1:1234#pnr=1", "http://h/x.ts", "mediamtx://canal63", "srt://h:9000", "file:///tmp/x.ts#rate=4000"]) {
      expect(checkAddress(ok, ["udp", "http", "mediamtx", "srt", "file"], "input")).toBeNull();
    }
  });

  it("rejects malformed addresses and unsupported types", () => {
    expect(checkAddress("239.1.1.1:1234", ["udp"], "input")).toBe("address-invalid");
    expect(checkAddress("udp://", ["udp"], "input")).toBe("address-invalid");
    expect(checkAddress("", ["udp"], "input")).toBe("address-invalid");
    expect(checkAddress("gopher://x", ["udp"], "input")).toBe("input-scheme");
    expect(checkAddress("http://x", ["udp"], "output")).toBe("output-scheme");
  });

  it("keeps CBR out of outputs, as the agent does", () => {
    expect(checkAddress("udp://239.1.1.1:1#cbr=4000", ["udp"], "output")).toBe("output-cbr");
    expect(checkAddress("udp://239.1.1.1:1#ttl=4&cbr=4000", ["udp"], "output")).toBe("output-cbr");
    expect(checkAddress("udp://239.1.1.1:1#cbr=4000", ["udp"], "input")).toBeNull();
  });
});

describe("validateServiceForm", () => {
  it("accepts the reference form", () => {
    expect(hasErrors(validateServiceForm(valid()))).toBe(false);
  });

  it("reports each problem where it is", () => {
    const f = valid({
      name: " ", serviceId: "0", pmtPid: "5", cbrKbps: "abc", returnDelaySec: "x",
      inputs: [{ url: "nonsense", timeoutSec: "0" }],
      outputs: [{ url: "http://x" }],
      streams: [
        { pid: "256", kind: "video", lang: "", fallbackAny: false },
        { pid: "256", kind: "audio", lang: "es", fallbackAny: false },
        { pid: "99999", kind: "audio", lang: "", fallbackAny: false },
      ],
    });
    const e = validateServiceForm(f);
    expect(e.name).toBe("name-required");
    expect(e.serviceId).toBe("service-id-invalid");
    expect(e.pmtPid).toBe("pid-invalid");
    expect(e.cbrKbps).toBe("cbr-invalid");
    expect(e.returnDelaySec).toBe("delay-invalid");
    expect(e.inputs[0]).toEqual({ url: "address-invalid", timeoutSec: "timeout-invalid" });
    expect(e.outputs[0]).toEqual({ url: "output-scheme" });
    expect(e.streams[1]).toEqual({ pid: "pid-duplicate", lang: "lang-invalid" });
    expect(e.streams[2]).toEqual({ pid: "pid-invalid" });
    expect(hasErrors(e)).toBe(true);
  });

  it("does not let a stream take the PMT PID", () => {
    const e = validateServiceForm(valid({ pmtPid: "257" }));
    expect(e.streams[1]?.pid).toBe("pid-duplicate");
  });

  it("requires at least one input, output and stream", () => {
    expect(validateServiceForm(valid({ inputs: [] })).general).toBe("inputs-required");
    // No output is valid: the service is watched through HTTP play.
    expect(hasErrors(validateServiceForm(valid({ outputs: [] })))).toBe(false);
    expect(validateServiceForm(valid({ streams: [] })).general).toBe("streams-required");
  });

  it("ignores the return delay in manual mode", () => {
    expect(validateServiceForm(valid({ backupMode: "manual", returnDelaySec: "x" })).returnDelaySec).toBeUndefined();
  });
});
