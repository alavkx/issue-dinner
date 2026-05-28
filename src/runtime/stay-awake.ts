import { spawn } from "node:child_process";
import type * as CommandExecutor from "@effect/platform/CommandExecutor";
import * as Effect from "effect/Effect";
import { commandExists } from "../util/exec.js";
import * as out from "../ui/out.js";

export const STAY_AWAKE_FLAG = "--stay-awake";

export function isStayAwakeEnabled(args: ReadonlyArray<string>): boolean {
  return args.includes(STAY_AWAKE_FLAG);
}

/** Flags to append when spawning serve from launch/tmux. */
export function stayAwakeInvocationFlags(
  enabled: boolean,
): ReadonlyArray<string> {
  return enabled ? [STAY_AWAKE_FLAG] : [];
}

let started = false;

/** Hold an idle-sleep assertion for this process until it exits (macOS only). */
export const startStayAwake = (): Effect.Effect<
  void,
  never,
  CommandExecutor.CommandExecutor
> =>
  Effect.gen(function* () {
    if (started) return;
    if (process.platform !== "darwin") {
      out.warn("stay-awake: only supported on macOS — ignoring");
      return;
    }
    if (!(yield* commandExists("caffeinate"))) {
      out.warn("stay-awake: caffeinate not found on PATH — ignoring");
      return;
    }
    started = true;
    const child = spawn("caffeinate", ["-i", "-w", String(process.pid)], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
    out.info("stay-awake: preventing idle sleep (caffeinate -i)");
  });
