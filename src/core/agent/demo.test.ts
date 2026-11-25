import { describe, expect, it } from "vitest";
import { createAgentClient } from "./api";
import { createDemoAgentTransport, DEMO_AGENT_TOKEN, DEMO_AGENT_URL, resolveMapping } from "./demo";
import { formToService, EMPTY_SERVICE_FORM } from "./form";

const make = () => createAgentClient({ baseUrl: DEMO_AGENT_URL, token: DEMO_AGENT_TOKEN, transport: createDemoAgentTransport(() => 1_000_000_000_000), pageProtocol: "https:" });

describe("demo agent", () => {
  it("rejects a wrong token", async () => {
    const client = createAgentClient({ baseUrl: DEMO_AGENT_URL, token: "nope", transport: createDemoAgentTransport(), pageProtocol: "https:" });
    await expect(client.list()).rejects.toMatchObject({ status: 401 });
  });

  it("starts with a running service whose mapping follows the languages", async () => {
    const [view] = await make().list();
    expect(view?.status.state).toBe("running");
    expect(view?.status.mapping.map((m) => [m.outPid, m.inPid, m.state])).toEqual([[256, 1331, "ok"], [257, 1333, "ok"], [258, 1332, "ok"]]);
  });

  it("keeps the output PIDs when the active input changes", async () => {
    const client = make();
    const after = await client.switchInput("deportes-hd", 1);
    expect(after.status.activeInput).toBe(1);
    expect(after.status.mapping.map((m) => [m.outPid, m.inPid, m.state])).toEqual([[256, 2000, "ok"], [257, 2001, "ok"], [258, 2002, "ok"]]);
    expect(after.status.events[0]?.message).toContain("cambio manual");
    await expect(client.switchInput("deportes-hd", 9)).rejects.toMatchObject({ status: 400 });
  });

  it("creates, updates, stops, resumes and deletes a service", async () => {
    const client = make();
    const created = await client.create({ ...formToService({ ...EMPTY_SERVICE_FORM, name: "Cámara Patio", inputs: [{ url: "udp://239.1.1.9:1234", timeoutSec: "" }], outputs: [{ url: "udp://239.2.2.2:1234" }] }) });
    expect(created.service.id).toBe("camara-patio");
    await expect(client.create({ ...created.service, id: "camara-patio" })).rejects.toMatchObject({ status: 409 });
    const renamed = await client.update({ ...created.service, name: "Patio" });
    expect(renamed.service.name).toBe("Patio");
    expect((await client.setEnabled("camara-patio", false)).status.state).toBe("stopped");
    expect((await client.setEnabled("camara-patio", true)).status.state).toBe("running");
    await client.remove("camara-patio");
    expect((await client.list()).map((v) => v.service.id)).toEqual(["deportes-hd"]);
    await expect(client.remove("camara-patio")).rejects.toMatchObject({ status: 404 });
  });
});

describe("resolveMapping", () => {
  const profile = {
    serviceId: 1, pmtPid: 4096,
    streams: [
      { pid: 256, kind: "video" as const },
      { pid: 257, kind: "audio" as const, lang: "spa", fallbackAny: true },
      { pid: 258, kind: "audio" as const, lang: "eng" },
    ],
  };
  const program = (langs: string[]) => ({
    number: 1, pmtPid: 4096, pcrPid: 1, version: 0,
    streams: [{ pid: 1, type: 27, kind: "video" as const, codec: "h264" }, ...langs.map((lang, i) => ({ pid: 10 + i, type: 15, kind: "audio" as const, codec: "aac", lang }))],
  });

  it("matches exact languages first, so a fallback never steals a track another PID needs", () => {
    expect(resolveMapping(profile, program(["eng"])).map((m) => m.state)).toEqual(["ok", "missing", "ok"]);
  });

  it("uses a fallback only for leftovers", () => {
    const map = resolveMapping(profile, program(["eng", "fra"]));
    expect(map.map((m) => [m.inPid, m.state])).toEqual([[1, "ok"], [11, "fallback"], [10, "ok"]]);
  });

  it("is all missing before any input is analyzed", () => {
    expect(resolveMapping(profile, undefined).every((m) => m.state === "missing")).toBe(true);
  });
});
