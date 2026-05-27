import type { DinnerConfig } from "../config.js";
import type { VerifyCommand } from "./runner.js";

export function resolveVerifyCommands(
  config: DinnerConfig,
  issueKey: string,
  workspaceKey: string,
): VerifyCommand[] {
  return (
    config.issueVerifyCommands?.[issueKey] ??
    config.verifyCommands?.[workspaceKey] ??
    []
  );
}
