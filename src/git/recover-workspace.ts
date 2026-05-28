import { commitWorkspaceWip, gitIsDirty } from "./workspace.js";
import { runCommand } from "../util/exec.js";

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
export async function recoverDirtyWorkspace(
  workspaceKey: string,
  cwd: string,
  issueKey: string,
  summary: string,
): Promise<WorkspaceRecoveryResult> {
  if (!(await gitIsDirty(cwd))) {
    return { cwd, ok: true, action: "already_clean" };
  }

  const commit = await commitWorkspaceWip(workspaceKey, cwd, issueKey, summary);
  if (commit.committed) {
    return {
      cwd,
      ok: true,
      action: "committed",
      detail: commit.sha,
    };
  }

  if (!(await gitIsDirty(cwd))) {
    return { cwd, ok: true, action: "already_clean" };
  }

  try {
    await runCommand(
      "git",
      [
        "stash",
        "push",
        "--all",
        "--include-untracked",
        "-m",
        `issue-dinner auto-stash ${issueKey}`,
      ],
      { cwd },
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { cwd, ok: false, action: "failed", detail: msg };
  }

  if (await gitIsDirty(cwd)) {
    return {
      cwd,
      ok: false,
      action: "failed",
      detail: "working tree still dirty after stash",
    };
  }

  return { cwd, ok: true, action: "stashed" };
}

export async function recoverDirtyWorkspaces(
  issueKey: string,
  summary: string,
  workspaces: Array<{ key: string; cwd: string }>,
): Promise<WorkspaceRecoveryResult[]> {
  const results: WorkspaceRecoveryResult[] = [];
  for (const ws of workspaces) {
    results.push(
      await recoverDirtyWorkspace(ws.key, ws.cwd, issueKey, summary),
    );
  }
  return results;
}
