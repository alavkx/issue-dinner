import type * as CommandExecutor from "@effect/platform/CommandExecutor";
import * as Effect from "effect/Effect";
import { CommandFailed } from "../effect/errors.js";
import { runCommand } from "../util/exec.js";

export interface WorkspaceGitState {
  workspaceKey: string;
  cwd: string;
  branch: string;
  dirty: boolean;
  diffStat: string;
}

export const gitCurrentBranch = (
  cwd: string,
): Effect.Effect<
  string,
  import("@effect/platform/Error").PlatformError | CommandFailed,
  CommandExecutor.CommandExecutor
> =>
  runCommand("git", ["branch", "--show-current"], { cwd }).pipe(
    Effect.map(({ stdout }) => stdout.trim() || "(detached)"),
  );

export const gitDiffStat = (
  cwd: string,
): Effect.Effect<string, never, CommandExecutor.CommandExecutor> =>
  runCommand("git", ["diff", "--stat", "HEAD"], { cwd }).pipe(
    Effect.map(({ stdout }) => stdout.trim()),
    Effect.catchAll(() => Effect.succeed("")),
  );

export const gitIsDirty = (
  cwd: string,
): Effect.Effect<
  boolean,
  import("@effect/platform/Error").PlatformError | CommandFailed,
  CommandExecutor.CommandExecutor
> =>
  runCommand("git", ["status", "--porcelain"], { cwd }).pipe(
    Effect.map(({ stdout }) => stdout.trim().length > 0),
  );

export const collectWorkspaceGitState = (
  workspaceKey: string,
  cwd: string,
): Effect.Effect<
  WorkspaceGitState,
  import("@effect/platform/Error").PlatformError | CommandFailed,
  CommandExecutor.CommandExecutor
> =>
  Effect.gen(function* () {
    const [branch, dirty, diffStat] = yield* Effect.all([
      gitCurrentBranch(cwd),
      gitIsDirty(cwd),
      gitDiffStat(cwd),
    ]);
    return { workspaceKey, cwd, branch, dirty, diffStat };
  });

export interface CommitResult {
  workspaceKey: string;
  cwd: string;
  branch: string;
  committed: boolean;
  sha?: string;
  message?: string;
  error?: string;
}

export const commitWorkspaceWip = (
  workspaceKey: string,
  cwd: string,
  issueKey: string,
  summary: string,
): Effect.Effect<
  CommitResult,
  import("@effect/platform/Error").PlatformError | CommandFailed,
  CommandExecutor.CommandExecutor
> =>
  Effect.gen(function* () {
    const branch = yield* gitCurrentBranch(cwd);
    const dirty = yield* gitIsDirty(cwd);
    if (!dirty) {
      return { workspaceKey, cwd, branch, committed: false };
    }

    const subject = summary.replace(/\s+/g, " ").slice(0, 72);
    const message = `feat(${issueKey.toLowerCase()}): ${subject}`;

    const outcome = yield* Effect.either(
      Effect.gen(function* () {
        yield* runCommand("git", ["add", "-A"], { cwd });
        yield* runCommand("git", ["commit", "-m", message], { cwd });
        const { stdout } = yield* runCommand(
          "git",
          ["rev-parse", "--short", "HEAD"],
          { cwd },
        );
        return {
          workspaceKey,
          cwd,
          branch,
          committed: true as const,
          sha: stdout.trim(),
          message,
        };
      }),
    );

    if (outcome._tag === "Right") return outcome.right;

    const msg =
      outcome.left instanceof CommandFailed
        ? outcome.left.message
        : outcome.left instanceof Error
          ? outcome.left.message
          : String(outcome.left);

    return {
      workspaceKey,
      cwd,
      branch,
      committed: false,
      error: msg,
    };
  });

export const commitCourseWip = (
  issueKey: string,
  summary: string,
  workspaces: Array<{ key: string; cwd: string }>,
): Effect.Effect<
  CommitResult[],
  import("@effect/platform/Error").PlatformError | CommandFailed,
  CommandExecutor.CommandExecutor
> =>
  Effect.gen(function* () {
    const results: CommitResult[] = [];
    for (const ws of workspaces) {
      results.push(
        yield* commitWorkspaceWip(ws.key, ws.cwd, issueKey, summary),
      );
    }
    return results;
  });
