import type { DinnerConfig } from "../config.js";
import { resolveCwd } from "../config/workspaces.js";
import { inferInnerVerifyCommands } from "./infer.js";
import type { VerifyCommand } from "./runner.js";
import { effectiveVerifyTier } from "./tier.js";

export type { VerifyCommand };

export type ResolvedVerifyCommand = VerifyCommand & { cwd: string };

export function resolveVerifyCommandsForIssue(
  config: DinnerConfig,
  issueKey: string,
  workspaceKeys: string[],
): ResolvedVerifyCommand[] {
  const issueCommands = config.issueVerifyCommands?.[issueKey];
  let resolved: ResolvedVerifyCommand[];
  if (issueCommands) {
    resolved = issueCommands.map((cmd) => ({
      ...cmd,
      cwd: resolveCwd(config, cmd.workspace ?? workspaceKeys[0]!),
    }));
  } else {
    resolved = [];
    for (const key of workspaceKeys) {
      const commands = config.verifyCommands?.[key] ?? [];
      const cwd = resolveCwd(config, key);
      for (const cmd of commands) {
        resolved.push({
          ...cmd,
          cwd: cmd.workspace ? resolveCwd(config, cmd.workspace) : cwd,
        });
      }
    }
  }

  const hasInner = resolved.some((c) => effectiveVerifyTier(c) === "inner");
  if (!hasInner) {
    resolved = [...resolved, ...inferInnerVerifyCommands(resolved)];
  }
  return resolved;
}

/** @deprecated use resolveVerifyCommandsForIssue */
export function resolveVerifyCommands(
  config: DinnerConfig,
  issueKey: string,
  workspaceKey: string,
): ResolvedVerifyCommand[] {
  return resolveVerifyCommandsForIssue(config, issueKey, [workspaceKey]);
}
