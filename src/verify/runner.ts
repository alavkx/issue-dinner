import type * as CommandExecutor from "@effect/platform/CommandExecutor";
import type { ServeVerifyGate } from "../config.js";
import * as Effect from "effect/Effect";
import { CommandFailed } from "../effect/errors.js";
import { runCommand } from "../util/exec.js";
import { fg } from "../ui/theme.js";
import type { ResolvedVerifyCommand } from "./resolve.js";
import { effectiveVerifyTier } from "./tier.js";

export interface VerifyCommand {
  name: string;
  command: string;
  args: string[];
  workspace?: string;
  tier?: "inner" | "outer";
}

/** Commands that run during serve, based on serveVerifyGate. */
export function filterVerifyCommandsForServe(
  commands: ResolvedVerifyCommand[],
  gate: ServeVerifyGate,
): ResolvedVerifyCommand[] {
  if (gate === "none") return [];
  if (gate === "full") return commands;
  return commands.filter((cmd) => effectiveVerifyTier(cmd) === "inner");
}

export interface VerifyRunResult {
  ok: boolean;
  failures: Array<{ name: string; exitCode: number; output: string }>;
  output: string;
}

export const runVerifyCommands = (
  commands: ResolvedVerifyCommand[],
): Effect.Effect<VerifyRunResult, never, CommandExecutor.CommandExecutor> =>
  Effect.gen(function* () {
    const lines: string[] = [];
    const failures: VerifyRunResult["failures"] = [];

    for (const cmd of commands) {
      lines.push(
        fg.cyan(`[${cmd.cwd}]`) +
          ` ${fg.bold("$")} ${cmd.command} ${cmd.args.join(" ")}`,
      );
      const outcome = yield* Effect.either(
        runCommand(cmd.command, cmd.args, { cwd: cmd.cwd }),
      );
      if (outcome._tag === "Right") {
        const { stdout, stderr } = outcome.right;
        if (stdout) lines.push(stdout);
        if (stderr) lines.push(stderr);
        continue;
      }

      const err = outcome.left;
      const output =
        err instanceof CommandFailed
          ? [err.stdout, err.stderr].filter(Boolean).join("\n")
          : "";
      if (output) lines.push(output);
      failures.push({
        name: cmd.name,
        exitCode: err instanceof CommandFailed ? err.code : 1,
        output,
      });
    }

    return { ok: failures.length === 0, failures, output: lines.join("\n") };
  });
