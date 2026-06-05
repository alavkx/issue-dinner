import type * as CommandExecutor from "@effect/platform/CommandExecutor";
import { CommandFailed } from "../effect/errors.js";
import * as Effect from "effect/Effect";
import type { MachineConfig } from "../config.js";
import { resolveIssueWorkspaces } from "../config/workspaces.js";
import { recoverDirtyWorkspaces } from "../git/recover-workspace.js";
import { gitIsDirty } from "../git/workspace.js";
import type { JiraIssue } from "../jira/acli.js";
import * as out from "../ui/out.js";

export interface WorkspaceCleanResult {
  ok: boolean;
  detail?: string;
}

/** Commit or stash dirty repos for this issue's workspaces so stack prep can run. */
export const ensureWorkspacesCleanForIssue = (
  config: MachineConfig,
  issue: JiraIssue,
  options: { label?: string } = {},
): Effect.Effect<
  WorkspaceCleanResult,
  import("@effect/platform/Error").PlatformError | CommandFailed,
  CommandExecutor.CommandExecutor
> =>
  Effect.gen(function* () {
    const roots = resolveIssueWorkspaces(
      config,
      issue.key,
      issue.description,
      issue.summary,
    );
    const workspaces = roots.keys.map((key, i) => ({
      key,
      cwd: roots.cwds[i]!,
    }));

    const label = options.label ?? issue.key;
    const results = yield* recoverDirtyWorkspaces(
      issue.key,
      issue.summary,
      workspaces,
    );

    for (const r of results) {
      if (r.action === "committed") {
        out.success(`${label}: committed WIP (${r.detail})`);
      } else if (r.action === "stashed") {
        out.warn(`${label}: stashed WIP so stack can advance`);
      } else if (!r.ok) {
        return {
          ok: false,
          detail: `${r.cwd}: ${r.detail ?? "recovery failed"}`,
        };
      }
    }

    for (const ws of workspaces) {
      if (yield* gitIsDirty(ws.cwd)) {
        return {
          ok: false,
          detail: `${ws.key}: working tree still dirty after auto-recovery`,
        };
      }
    }

    return { ok: true };
  });
