import type * as CommandExecutor from "@effect/platform/CommandExecutor";
import * as Effect from "effect/Effect";
import { CommandFailed } from "../effect/errors.js";
import { runCommand } from "../util/exec.js";
import { autoStashMessage } from "./restore-stash.js";
import { commitWorkspaceWip, gitIsDirty } from "./workspace.js";

export type WorkspaceRecoveryAction =
  | "already_clean"
  | "committed"
  | "stashed"
  | "failed";

export interface WorkspaceRecoveryResult {
  cwd: string;
  ok: boolean;
  action: WorkspaceRecoveryAction;
  detail?: string;
}

/** Make a repo checkoutable: commit WIP first, then stash if commit fails. */
export const recoverDirtyWorkspace = (
  workspaceKey: string,
  cwd: string,
  issueKey: string,
  summary: string,
): Effect.Effect<
  WorkspaceRecoveryResult,
  import("@effect/platform/Error").PlatformError | CommandFailed,
  CommandExecutor.CommandExecutor
> =>
  Effect.gen(function* () {
    if (!(yield* gitIsDirty(cwd))) {
      return { cwd, ok: true, action: "already_clean" as const };
    }

    const commit = yield* commitWorkspaceWip(
      workspaceKey,
      cwd,
      issueKey,
      summary,
    );
    if (commit.committed) {
      return {
        cwd,
        ok: true,
        action: "committed" as const,
        detail: commit.sha,
      };
    }

    if (!(yield* gitIsDirty(cwd))) {
      return { cwd, ok: true, action: "already_clean" as const };
    }

    const stashOutcome = yield* Effect.either(
      runCommand(
        "git",
        [
          "stash",
          "push",
          "--all",
          "--include-untracked",
          "-m",
          autoStashMessage(issueKey),
        ],
        { cwd },
      ),
    );

    if (stashOutcome._tag === "Left") {
      const err = stashOutcome.left;
      const msg =
        err instanceof CommandFailed
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err);
      return { cwd, ok: false, action: "failed" as const, detail: msg };
    }

    if (yield* gitIsDirty(cwd)) {
      return {
        cwd,
        ok: false,
        action: "failed" as const,
        detail: "working tree still dirty after stash",
      };
    }

    return { cwd, ok: true, action: "stashed" as const };
  });

export const recoverDirtyWorkspaces = (
  issueKey: string,
  summary: string,
  workspaces: Array<{ key: string; cwd: string }>,
): Effect.Effect<
  WorkspaceRecoveryResult[],
  import("@effect/platform/Error").PlatformError | CommandFailed,
  CommandExecutor.CommandExecutor
> =>
  Effect.gen(function* () {
    const results: WorkspaceRecoveryResult[] = [];
    for (const ws of workspaces) {
      results.push(
        yield* recoverDirtyWorkspace(ws.key, ws.cwd, issueKey, summary),
      );
    }
    return results;
  });
