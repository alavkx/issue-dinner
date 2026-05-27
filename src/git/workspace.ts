import { runCommand } from "../util/exec.js";

export interface WorkspaceGitState {
  workspaceKey: string;
  cwd: string;
  branch: string;
  dirty: boolean;
  diffStat: string;
}

export async function gitCurrentBranch(cwd: string): Promise<string> {
  const { stdout } = await runCommand(
    "git",
    ["branch", "--show-current"],
    { cwd },
  );
  return stdout.trim() || "(detached)";
}

export async function gitDiffStat(cwd: string): Promise<string> {
  try {
    const { stdout } = await runCommand("git", ["diff", "--stat", "HEAD"], {
      cwd,
    });
    return stdout.trim();
  } catch {
    return "";
  }
}

export async function gitIsDirty(cwd: string): Promise<boolean> {
  const { stdout } = await runCommand("git", ["status", "--porcelain"], {
    cwd,
  });
  return stdout.trim().length > 0;
}

export async function collectWorkspaceGitState(
  workspaceKey: string,
  cwd: string,
): Promise<WorkspaceGitState> {
  const [branch, dirty, diffStat] = await Promise.all([
    gitCurrentBranch(cwd),
    gitIsDirty(cwd),
    gitDiffStat(cwd),
  ]);
  return { workspaceKey, cwd, branch, dirty, diffStat };
}

export interface CommitResult {
  workspaceKey: string;
  cwd: string;
  branch: string;
  committed: boolean;
  sha?: string;
  message?: string;
  error?: string;
}

export async function commitWorkspaceWip(
  workspaceKey: string,
  cwd: string,
  issueKey: string,
  summary: string,
): Promise<CommitResult> {
  const branch = await gitCurrentBranch(cwd);
  const dirty = await gitIsDirty(cwd);
  if (!dirty) {
    return { workspaceKey, cwd, branch, committed: false };
  }

  const subject = summary.replace(/\s+/g, " ").slice(0, 72);
  const message = `feat(${issueKey.toLowerCase()}): ${subject}`;

  try {
    await runCommand("git", ["add", "-A"], { cwd });
    await runCommand("git", ["commit", "-m", message], { cwd });
    const { stdout } = await runCommand(
      "git",
      ["rev-parse", "--short", "HEAD"],
      { cwd },
    );
    return {
      workspaceKey,
      cwd,
      branch,
      committed: true,
      sha: stdout.trim(),
      message,
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      workspaceKey,
      cwd,
      branch,
      committed: false,
      error: msg,
    };
  }
}

export async function commitCourseWip(
  issueKey: string,
  summary: string,
  workspaces: Array<{ key: string; cwd: string }>,
): Promise<CommitResult[]> {
  const results: CommitResult[] = [];
  for (const ws of workspaces) {
    results.push(
      await commitWorkspaceWip(ws.key, ws.cwd, issueKey, summary),
    );
  }
  return results;
}
