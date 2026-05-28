import type { DinnerConfig } from "../config.js";
import { resolveCwd } from "../config/workspaces.js";
import * as Effect from "effect/Effect";
import * as FileSystem from "@effect/platform/FileSystem";
import { inferInnerVerifyCommands } from "./infer.js";
import type { VerifyCommand } from "./runner.js";
import { effectiveVerifyTier } from "./tier.js";

export type { VerifyCommand };

export type ResolvedVerifyCommand = VerifyCommand & { cwd: string };

type PlatformError = import("@effect/platform/Error").PlatformError;

export const resolveVerifyCommandsForIssue = (
  config: DinnerConfig,
  issueKey: string,
  workspaceKeys: string[],
): Effect.Effect<
  ResolvedVerifyCommand[],
  PlatformError,
  FileSystem.FileSystem
> =>
  Effect.gen(function* () {
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
      const inferred = yield* inferInnerVerifyCommands(resolved);
      resolved = [...resolved, ...inferred];
    }
    return resolved;
  });

/** @deprecated use resolveVerifyCommandsForIssue */
export const resolveVerifyCommands = (
  config: DinnerConfig,
  issueKey: string,
  workspaceKey: string,
): Effect.Effect<
  ResolvedVerifyCommand[],
  PlatformError,
  FileSystem.FileSystem
> => resolveVerifyCommandsForIssue(config, issueKey, [workspaceKey]);
