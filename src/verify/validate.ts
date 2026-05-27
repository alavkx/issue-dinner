import { existsSync } from "node:fs";
import { join } from "node:path";
import type { DinnerConfig } from "../config.js";
import { commandExists } from "../util/exec.js";
import { resolveVerifyCommandsForIssue } from "./resolve.js";

export interface VerifyValidationResult {
  ok: boolean;
  message: string;
  fix?: string;
}

function pathArgsFromCommand(args: string[]): string[] {
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

export function validateVerifyCommands(
  config: DinnerConfig,
  issueKey: string,
  workspaceKeys: string[],
): VerifyValidationResult[] {
  const results: VerifyValidationResult[] = [];
  const commands = resolveVerifyCommandsForIssue(config, issueKey, workspaceKeys);

  if (commands.length === 0) {
    results.push({
      ok: false,
      message: `verify: no commands configured`,
      fix: `Add issueVerifyCommands.${issueKey} or verifyCommands in config.json`,
    });
    return results;
  }

  for (const cmd of commands) {
    if (!commandExists(cmd.command)) {
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
      const exists = existsSync(abs);
      results.push({
        ok: exists,
        message: `verify ${cmd.name}: ${rel} ${exists ? "exists" : "missing"} (${cmd.cwd})`,
        fix: exists
          ? undefined
          : `Create ${rel} or update verify args in config.json for ${issueKey}`,
      });
    }
  }

  return results;
}
