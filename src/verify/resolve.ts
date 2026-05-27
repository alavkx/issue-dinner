import type { DinnerConfig } from "../config.js";
import { resolveCwd } from "../config/workspaces.js";
import type { VerifyCommand } from "./runner.js";

export type ResolvedVerifyCommand = VerifyCommand & { cwd: string };

export function resolveVerifyCommandsForIssue(
  config: DinnerConfig,
  issueKey: string,
  workspaceKeys: string[],
): ResolvedVerifyCommand[] {
  const issueCommands = config.issueVerifyCommands?.[issueKey];
  if (issueCommands) {
    return issueCommands.map((cmd) => ({
      ...cmd,
      cwd: resolveCwd(config, cmd.workspace ?? workspaceKeys[0]!),
    }));
  }

  const resolved: ResolvedVerifyCommand[] = [];
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
