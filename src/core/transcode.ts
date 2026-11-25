import type { ApiClient } from "./mediamtx/api";
import { addPathConf, deletePathConf, patchPathConf } from "./mediamtx/api";
import type { HookKeys } from "./mediamtx/pathConf";

export type Encoder = "libx264" | "h264_nvenc";

export interface Resolution {
  height: 1080 | 720 | 480 | 360;
  /** Video bitrate that suits the resolution, in kbps. */
  kbps: number;
}

export const RESOLUTIONS: readonly Resolution[] = [
  { height: 1080, kbps: 5000 },
  { height: 720, kbps: 2500 },
  { height: 480, kbps: 1200 },
  { height: 360, kbps: 700 },
];

export const DEFAULT_RESOLUTION = RESOLUTIONS[1]!;
export const DEFAULT_ENCODER: Encoder = "libx264";

/** Name of the transcoded path: `canal63` at 720p becomes `canal63_720`. */
export const destinationName = (origin: string, height: number): string => `${origin}_${height}`;

/** Names that can go into a shell command and an RTSP URL without quoting. */
const SAFE_NAME = /^[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)*$/;
export const isSafeForCommand = (name: string): boolean => SAFE_NAME.test(name);

export interface CommandOptions {
  origin: string;
  resolution: Resolution;
  encoder: Encoder;
  rtspPort: number;
}

const ENCODERS: Record<Encoder, string> = {
  libx264: "-c:v libx264 -preset veryfast -tune zerolatency",
  h264_nvenc: "-c:v h264_nvenc -preset p4 -tune ll",
};

/**
 * FFmpeg command run by MediaMTX when the origin comes online. It pulls the
 * origin over local RTSP and publishes the scaled copy to `<origin>_<height>`.
 * The audio mapping is optional (`0:a:0?`) so a channel without audio still works.
 */
export function buildFfmpegCommand({ origin, resolution, encoder, rtspPort }: CommandOptions): string {
  const base = `rtsp://127.0.0.1:${rtspPort}`;
  const { height, kbps } = resolution;
  return [
    "ffmpeg -hide_banner -loglevel error -rtsp_transport tcp",
    `-i ${base}/${origin}`,
    "-map 0:v:0 -map 0:a:0?",
    `-vf scale=-2:${height}`,
    ENCODERS[encoder],
    `-b:v ${kbps}k -maxrate ${kbps}k -bufsize ${kbps * 2}k -g 60`,
    "-c:a copy",
    `-f rtsp -rtsp_transport tcp ${base}/${destinationName(origin, height)}`,
  ].join(" ");
}

// ---- plan ----

export interface PlanOperation {
  kind: "add" | "patch";
  path: string;
  body: Record<string, unknown>;
  /** For `patch`: the values to put back if a later step fails. */
  revert?: Record<string, unknown>;
}

export type PlanWarning = "origin-dynamic" | "replaces-hook" | "destination-exists";
export type PlanError = "origin-unsafe" | "destination-unsafe";

export interface TranscodePlan {
  command: string;
  destination: string;
  operations: PlanOperation[];
  warnings: PlanWarning[];
  errors: PlanError[];
}

export interface PlanInput extends CommandOptions {
  hook: HookKeys;
  /** The origin has its own entry in the configuration (not created on demand). */
  originConfigured: boolean;
  /** Hook command the origin already has. */
  currentHook: string;
  currentHookRestart: boolean;
  destinationExists: boolean;
}

/**
 * Works out what the wizard will do: create the destination path (a plain
 * publisher path), and set the hook on the origin. A dynamic origin first gets
 * its own configuration, since a hook cannot be set on a path that does not exist.
 */
export function planTranscode(input: PlanInput): TranscodePlan {
  const destination = destinationName(input.origin, input.resolution.height);
  const command = buildFfmpegCommand(input);
  const warnings: PlanWarning[] = [];
  const errors: PlanError[] = [];
  if (!isSafeForCommand(input.origin)) errors.push("origin-unsafe");
  else if (!isSafeForCommand(destination)) errors.push("destination-unsafe");

  const operations: PlanOperation[] = [];
  if (input.destinationExists) warnings.push("destination-exists");
  else operations.push({ kind: "add", path: destination, body: { source: "publisher" } });

  const hookBody = { [input.hook.command]: command, [input.hook.restart]: true };
  if (!input.originConfigured) {
    warnings.push("origin-dynamic");
    operations.push({ kind: "add", path: input.origin, body: { source: "publisher", ...hookBody } });
  } else {
    if (input.currentHook && input.currentHook !== command) warnings.push("replaces-hook");
    operations.push({
      kind: "patch",
      path: input.origin,
      body: hookBody,
      revert: { [input.hook.command]: input.currentHook, [input.hook.restart]: input.currentHookRestart },
    });
  }
  return { command, destination, operations, warnings, errors };
}

/** Runs the plan; if a step fails, undoes the ones already done and rethrows. */
export async function applyPlan(client: ApiClient, operations: readonly PlanOperation[]): Promise<void> {
  const done: PlanOperation[] = [];
  try {
    for (const op of operations) {
      if (op.kind === "add") await addPathConf(client, op.path, op.body);
      else await patchPathConf(client, op.path, op.body);
      done.push(op);
    }
  } catch (error) {
    for (const op of done.reverse()) {
      // Best effort: the original error is the one worth reporting.
      if (op.kind === "add") await deletePathConf(client, op.path).catch(() => undefined);
      else if (op.revert) await patchPathConf(client, op.path, op.revert).catch(() => undefined);
    }
    throw error;
  }
}
