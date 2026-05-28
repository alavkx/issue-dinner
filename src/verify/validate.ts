import { join } from "node:path";
import * as FileSystem from "@effect/platform/FileSystem";
import type * as CommandExecutor from "@effect/platform/CommandExecutor";
import * as Effect from "effect/Effect";
import type { MachineConfig, ServeVerifyGate } from "../config.js";
import { commandExists } from "../util/exec.js";
import { resolveVerifyCommandsForIssue } from "./resolve.js";
import { filterVerifyCommandsForServe } from "./runner.js";

export interface VerifyValidationResult {
  ok: boolean;
  message: string;
  fix?: string;
}

function pathArgsFromCommand(args: ReadonlyArray<string>): string[] {
  const paths: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg.startsWith("-")) continue;
    if (arg === "run" || arg === "test" || arg === "--") continue;
    if (arg.includes("/") || arg.endsWith(".py") || arg.endsWith(".ts")) {
      paths.push(arg);
    }
  }
  return paths;
}

export const validateVerifyCommands = (
  config: MachineConfig,
  issueKey: string,
  workspaceKeys: string[],
  options: { gate?: ServeVerifyGate } = {},
): Effect.Effect<
  VerifyValidationResult[],
  import("@effect/platform/Error").PlatformError,
  CommandExecutor.CommandExecutor | FileSystem.FileSystem
> =>
  Effect.gen(function* () {
    const results: VerifyValidationResult[] = [];
    const all = yield* resolveVerifyCommandsForIssue(config, issueKey, workspaceKeys);
    const gate = options.gate ?? "full";
    const commands = filterVerifyCommandsForServe(all, gate);
    if (gate === "inner" && all.length > commands.length) {
      results.push({
        ok: true,
        message: `verify: ${all.length - commands.length} outer command(s) deferred (serveVerifyGate=inner)`,
      });
    }

    if (commands.length === 0) {
      if (gate === "inner") {
        const detail =
          all.length > 0
            ? "only slow tests — quick checks skipped during serve"
            : "no test recipe — quick checks skipped during serve";
        results.push({
          ok: true,
          message: `verify: ${issueKey} ${detail}`,
        });
        return results;
      }
      results.push({
        ok: false,
        message: `verify: no test commands configured for ${issueKey}`,
        fix: `Run: issue-dinner verify ${issueKey} after wiring tests, or use serveVerifyGate inner (default) to skip blocking`,
      });
      return results;
    }

    for (const cmd of commands) {
      if (!(yield* commandExists(cmd.command))) {
        results.push({
          ok: false,
          message: `verify ${cmd.name}: ${cmd.command} not on PATH`,
          fix: `Install ${cmd.command} or update verify command for ${issueKey}`,
        });
        continue;
      }

      const pathArgs = pathArgsFromCommand(cmd.args);
      if (pathArgs.length === 0) {
        results.push({
          ok: true,
          message: `verify ${cmd.name}: ${cmd.command} (no path args to check)`,
        });
        continue;
      }

      for (const rel of pathArgs) {
        const abs = join(cmd.cwd, rel);
        const fs = yield* FileSystem.FileSystem;
        const exists = yield* fs.exists(abs);
        results.push({
          ok: exists,
          message: `verify ${cmd.name}: ${rel} ${exists ? "exists" : "missing"} (${cmd.cwd})`,
          fix: exists
            ? undefined
            : `Create ${rel} in the repo or re-run after the agent adds tests for ${issueKey}`,
        });
      }
    }

    return results;
  });
