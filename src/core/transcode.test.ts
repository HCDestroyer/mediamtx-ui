import { describe, expect, it } from "vitest";
import type { ApiClient } from "./mediamtx/api";
import { detectHookKeys } from "./mediamtx/pathConf";
import {
  applyPlan, buildFfmpegCommand, DEFAULT_RESOLUTION, destinationName, isSafeForCommand, planTranscode,
  RESOLUTIONS, type PlanInput,
} from "./transcode";

const modern = detectHookKeys({ runOnOnline: "" });

describe("buildFfmpegCommand", () => {
  it("matches the agreed 720p libx264 template (with an optional audio map)", () => {
    expect(buildFfmpegCommand({ origin: "canal63", resolution: DEFAULT_RESOLUTION, encoder: "libx264", rtspPort: 8554 })).toBe(
      "ffmpeg -hide_banner -loglevel error -rtsp_transport tcp -i rtsp://127.0.0.1:8554/canal63 " +
        "-map 0:v:0 -map 0:a:0? -vf scale=-2:720 -c:v libx264 -preset veryfast -tune zerolatency " +
        "-b:v 2500k -maxrate 2500k -bufsize 5000k -g 60 -c:a copy " +
        "-f rtsp -rtsp_transport tcp rtsp://127.0.0.1:8554/canal63_720",
    );
  });

  it("defaults to 720p", () => {
    expect(DEFAULT_RESOLUTION.height).toBe(720);
  });

  it("scales bitrate and names with the resolution and uses the server's RTSP port", () => {
    const command = buildFfmpegCommand({ origin: "cams/patio", resolution: RESOLUTIONS[0]!, encoder: "libx264", rtspPort: 9554 });
    expect(command).toContain("-i rtsp://127.0.0.1:9554/cams/patio");
    expect(command).toContain("scale=-2:1080");
    expect(command).toContain("-b:v 5000k -maxrate 5000k -bufsize 10000k");
    expect(command.endsWith("rtsp://127.0.0.1:9554/cams/patio_1080")).toBe(true);
  });

  it("switches to NVENC", () => {
    const command = buildFfmpegCommand({ origin: "a", resolution: DEFAULT_RESOLUTION, encoder: "h264_nvenc", rtspPort: 8554 });
    expect(command).toContain("-c:v h264_nvenc -preset p4 -tune ll");
    expect(command).not.toContain("libx264");
  });
});

describe("names", () => {
  it("builds the destination and checks that names are shell-safe", () => {
    expect(destinationName("canal63", 720)).toBe("canal63_720");
    for (const ok of ["canal63", "cams/patio.1", "a-b_c"]) expect(isSafeForCommand(ok)).toBe(true);
    for (const bad of ["a b", "a;b", "$x", "~^cam", "a'b", "", "/a", "a/"]) expect(isSafeForCommand(bad)).toBe(false);
  });
});

const input = (overrides: Partial<PlanInput> = {}): PlanInput => ({
  origin: "canal63", resolution: DEFAULT_RESOLUTION, encoder: "libx264", rtspPort: 8554, hook: modern,
  originConfigured: true, currentHook: "", currentHookRestart: false, destinationExists: false, ...overrides,
});

describe("planTranscode", () => {
  it("creates the destination and sets the hook on the origin", () => {
    const plan = planTranscode(input());
    expect(plan.destination).toBe("canal63_720");
    expect(plan.warnings).toEqual([]);
    expect(plan.errors).toEqual([]);
    expect(plan.operations).toEqual([
      { kind: "add", path: "canal63_720", body: { source: "publisher" } },
      {
        kind: "patch", path: "canal63",
        body: { runOnOnline: plan.command, runOnOnlineRestart: true },
        revert: { runOnOnline: "", runOnOnlineRestart: false },
      },
    ]);
  });

  it("uses the older hook names on older servers", () => {
    const plan = planTranscode(input({ hook: detectHookKeys(null) }));
    expect(plan.operations[1]?.body).toEqual({ runOnReady: plan.command, runOnReadyRestart: true });
  });

  it("warns before replacing a different hook and remembers it for the rollback", () => {
    const plan = planTranscode(input({ currentHook: "ffmpeg other", currentHookRestart: true }));
    expect(plan.warnings).toEqual(["replaces-hook"]);
    expect(plan.operations[1]?.revert).toEqual({ runOnOnline: "ffmpeg other", runOnOnlineRestart: true });
  });

  it("does not warn when the same command is already set", () => {
    const first = planTranscode(input());
    expect(planTranscode(input({ currentHook: first.command })).warnings).toEqual([]);
  });

  it("gives a dynamic origin its own configuration first", () => {
    const plan = planTranscode(input({ originConfigured: false }));
    expect(plan.warnings).toEqual(["origin-dynamic"]);
    expect(plan.operations[1]).toMatchObject({ kind: "add", path: "canal63", body: { source: "publisher" } });
  });

  it("reuses a destination that already exists", () => {
    const plan = planTranscode(input({ destinationExists: true }));
    expect(plan.warnings).toEqual(["destination-exists"]);
    expect(plan.operations.map((o) => o.path)).toEqual(["canal63"]);
  });

  it("refuses names that cannot go into a command", () => {
    expect(planTranscode(input({ origin: "mi canal" })).errors).toEqual(["origin-unsafe"]);
    expect(planTranscode(input({ origin: "~^cam" })).errors).toEqual(["origin-unsafe"]);
  });
});

function fakeClient(failOn?: string) {
  const calls: string[] = [];
  const client: ApiClient = {
    get: async () => { throw new Error("unused"); },
    send: async (method, path) => {
      calls.push(`${method} ${path}`);
      if (failOn && `${method} ${path}` === failOn) throw new Error("boom");
      return undefined as never;
    },
  };
  return { client, calls };
}

describe("applyPlan", () => {
  it("runs the operations in order", async () => {
    const { client, calls } = fakeClient();
    await applyPlan(client, planTranscode(input()).operations);
    expect(calls).toEqual(["POST /v3/config/paths/add/canal63_720", "PATCH /v3/config/paths/patch/canal63"]);
  });

  it("undoes what was done when a step fails", async () => {
    const { client, calls } = fakeClient("PATCH /v3/config/paths/patch/canal63");
    await expect(applyPlan(client, planTranscode(input()).operations)).rejects.toThrow("boom");
    expect(calls).toEqual([
      "POST /v3/config/paths/add/canal63_720",
      "PATCH /v3/config/paths/patch/canal63",
      "DELETE /v3/config/paths/delete/canal63_720",
    ]);
  });

  it("restores the origin hook when a later step fails", async () => {
    const { client, calls } = fakeClient("POST /v3/config/paths/add/canal63");
    const plan = planTranscode(input({ originConfigured: false, destinationExists: true }));
    await expect(applyPlan(client, plan.operations)).rejects.toThrow("boom");
    expect(calls).toEqual(["POST /v3/config/paths/add/canal63"]);
  });
});
