import { existsSync } from "node:fs";
import type { DinnerConfig } from "../config.js";
import {
  resolveIssueWorkspaces,
} from "../config/workspaces.js";
import { cursorApiKeyEnvName } from "../env.js";
import type { JiraIssue } from "../jira/acli.js";
import type { StackConfig } from "../stack/stack-config.js";
import { commandExists, runCommand } from "../util/exec.js";
import { validateVerifyCommands } from "../verify/validate.js";

export interface PreflightIssue {
  ok: boolean;
  message: string;
  fix?: string;
}

export interface PreflightReport {
  ok: boolean;
  issues: PreflightIssue[];
}

function push(
  issues: PreflightIssue[],
  ok: boolean,
  message: string,
  fix?: string,
): void {
  issues.push({ ok, message, fix });
}

export async function runPreflight(options: {
  config: DinnerConfig;
  stack: StackConfig;
  menuIssues: JiraIssue[];
  requireApiKey?: boolean;
  checkGraphite?: boolean;
  checkTmux?: boolean;
  validateVerify?: boolean;
}): Promise<PreflightReport> {
  const issues: PreflightIssue[] = [];
  const apiEnv = cursorApiKeyEnvName();

  if (options.requireApiKey !== false) {
    const key = process.env[apiEnv]?.trim();
    push(
      issues,
      Boolean(key),
      key ? `${apiEnv} is set` : `${apiEnv} is not set`,
      key
        ? undefined
        : `export ${apiEnv}="cursor_…"  # https://cursor.com/dashboard/integrations`,
    );
  }

  push(
    issues,
    commandExists("acli"),
    "acli on PATH",
    "Install Atlassian CLI and run: acli jira auth login --web",
  );

  push(
    issues,
    commandExists("cursor"),
    "cursor CLI on PATH (local agents)",
    "Install Cursor CLI — issue-dinner runs local SDK agents, not cloud",
  );

  if (options.checkGraphite !== false) {
    push(
      issues,
      commandExists("gt"),
      "gt (Graphite) on PATH",
      "Install Graphite CLI or use --no-prep on launch",
    );
  }

  if (options.checkTmux) {
    push(
      issues,
      commandExists("tmux"),
      "tmux on PATH",
      "Install tmux or run: issue-dinner CPD-XXX serve",
    );
  }

  for (const [key, cwd] of Object.entries(options.config.workspaces)) {
    const exists = existsSync(cwd);
    push(
      issues,
      exists,
      `workspace ${key}: ${cwd}`,
      exists ? undefined : `Fix workspaces.${key} in ~/.config/issue-dinner/config.json`,
    );
    if (!exists) continue;

    try {
      const { stdout } = await runCommand("git", ["status", "--porcelain"], {
        cwd,
      });
      const clean = stdout.trim().length === 0;
      push(
        issues,
        clean,
        `${key}: working tree clean`,
        clean
          ? undefined
          : `cd ${cwd} && git stash -u  # or commit before dinner`,
      );
    } catch {
      push(issues, false, `${key}: git status failed`, `Check ${cwd} is a git repo`);
    }
  }

  if (options.checkGraphite !== false && commandExists("gt")) {
    for (const [key, cwd] of Object.entries(options.config.workspaces)) {
      if (!existsSync(cwd)) continue;
      try {
        await runCommand(
          "gt",
          ["log", "short", "--cwd", cwd],
          { cwd },
        );
        push(issues, true, `${key}: Graphite initialized`);
      } catch {
        push(
          issues,
          false,
          `${key}: Graphite not initialized`,
          `cd ${cwd} && gt init && gt track --parent ${options.stack.graphiteTrunk}`,
        );
      }
    }
  }

  if (options.validateVerify !== false) {
    for (const issue of options.menuIssues) {
      const roots = resolveIssueWorkspaces(
        options.config,
        issue.key,
        issue.description,
        issue.summary,
      );
      const validation = validateVerifyCommands(
        options.config,
        issue.key,
        roots.keys,
      );
      for (const v of validation) {
        push(issues, v.ok, `${issue.key}: ${v.message}`, v.fix);
      }
    }
  }

  const ok = issues.every((i) => i.ok);
  return { ok, issues };
}

export function formatPreflightReport(report: PreflightReport): string {
  const lines = ["Preflight checks:", ""];
  for (const item of report.issues) {
    const mark = item.ok ? "✓" : "✗";
    lines.push(`${mark} ${item.message}`);
    if (!item.ok && item.fix) lines.push(`  → ${item.fix}`);
  }
  if (!report.ok) {
    lines.push("");
    lines.push("Fix the items above, then re-run launch.");
  }
  return lines.join("\n");
}

export function assertPreflight(report: PreflightReport): void {
  if (report.ok) return;
  throw new Error(formatPreflightReport(report));
}
