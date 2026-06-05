import type * as CommandExecutor from "@effect/platform/CommandExecutor";
import * as Effect from "effect/Effect";
import { CommandFailed } from "../effect/errors.js";
import { runCommand } from "../util/exec.js";

export const autoStashMessage = (issueKey: string): string =>
  `issue-dinner auto-stash ${issueKey}`;

export interface RestoreAutoStashResult {
  cwd: string;
  restored: boolean;
  detail?: string;
}

/** Re-apply WIP that the orchestrator stashed for this issue before stack prep or preflight. */
export const restoreAutoStashedWork = (
  cwd: string,
  issueKey: string,
): Effect.Effect<
  RestoreAutoStashResult,
  import("@effect/platform/Error").PlatformError | CommandFailed,
  CommandExecutor.CommandExecutor
> =>
  Effect.gen(function* () {
    const label = autoStashMessage(issueKey);
    const listOutcome = yield* Effect.either(
      runCommand("git", ["stash", "list"], { cwd }),
    );
    if (listOutcome._tag === "Left") {
      const err = listOutcome.left;
      const msg =
        err instanceof CommandFailed
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err);
      return { cwd, restored: false, detail: msg };
    }

    let stashRef: string | undefined;
    for (const line of listOutcome.right.stdout.split("\n")) {
      if (!line.includes(label)) continue;
      const match = line.match(/^(stash@\{\d+\})/);
      if (match) {
        stashRef = match[1];
        break;
      }
    }

    if (!stashRef) {
      return { cwd, restored: false };
    }

    const popOutcome = yield* Effect.either(
      runCommand("git", ["stash", "pop", stashRef], { cwd }),
    );
    if (popOutcome._tag === "Left") {
      const err = popOutcome.left;
      const msg =
        err instanceof CommandFailed
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err);
      return { cwd, restored: false, detail: msg };
    }

    return { cwd, restored: true, detail: stashRef };
  });

export const restoreAutoStashedWorkspaces = (
  issueKey: string,
  workspaces: ReadonlyArray<{ key: string; cwd: string }>,
): Effect.Effect<
  RestoreAutoStashResult[],
  import("@effect/platform/Error").PlatformError | CommandFailed,
  CommandExecutor.CommandExecutor
> =>
  Effect.gen(function* () {
    const results: RestoreAutoStashResult[] = [];
    for (const ws of workspaces) {
      results.push(yield* restoreAutoStashedWork(ws.cwd, issueKey));
    }
    return results;
  });
