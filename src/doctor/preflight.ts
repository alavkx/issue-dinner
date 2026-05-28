import { existsSync } from "node:fs";
import type { DinnerConfig } from "../config.js";
import { resolveIssueWorkspaces } from "../config/workspaces.js";
import { cursorApiKeyEnvName } from "../env.js";
import { recoverDirtyWorkspace } from "../git/recover-workspace.js";
import type { JiraIssue } from "../jira/acli.js";
import type { StackConfig } from "../stack/stack-config.js";
import { commandExists, runCommand } from "../util/exec.js";
import { validateVerifyCommands } from "../verify/validate.js";
import { StateStore } from "../state/store.js";
import {
  explainPreflightFailure,
  type PreflightExplanation,
} from "../serve/explain.js";
import { fg } from "../ui/theme.js";
import * as Effect from "effect/Effect";
import type * as CommandExecutor from "@effect/platform/CommandExecutor";

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

/** Issue whose WIP likely owns a dirty workspace (resume / in-progress). */
const recoveryIssueForWorkspace = (
  workspaceKey: string,
  menuIssues: JiraIssue[],
  config: DinnerConfig,
): Effect.Effect<JiraIssue | undefined, never, StateStore> =>
  Effect.gen(function* () {
    const store = yield* StateStore;
    const touches = (issue: JiraIssue) =>
      resolveIssueWorkspaces(
        config,
        issue.key,
        issue.description,
        issue.summary,
      ).keys.includes(workspaceKey);

    for (const issue of menuIssues) {
      if (
        touches(issue) &&
        (yield* store.get(issue.key))?.status === "agent_complete"
      ) {
        return issue;
      }
    }

    for (const issue of menuIssues) {
      if (
        touches(issue) &&
        (yield* store.get(issue.key))?.status === "running"
      ) {
        return issue;
      }
    }

    return menuIssues.find(touches);
  });

const shouldSkipVerifyPathsForIssue = (
  issueKey: string,
): Effect.Effect<boolean, never, StateStore> =>
  Effect.gen(function* () {
    const store = yield* StateStore;
    const status = (yield* store.get(issueKey))?.status;
    return (
      status === "verified" ||
      status === "finished" ||
      status === "agent_complete"
    );
  });

export const runPreflight = (options: {
  config: DinnerConfig;
  stack: StackConfig;
  menuIssues: JiraIssue[];
  requireApiKey?: boolean;
  checkGraphite?: boolean;
  checkTmux?: boolean;
  validateVerify?: boolean;
}): Effect.Effect<
  PreflightReport,
  never,
  StateStore | CommandExecutor.CommandExecutor
> =>
  Effect.gen(function* () {
    const store = yield* StateStore;
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
      yield* commandExists("acli"),
      "acli on PATH",
      "Install Atlassian CLI and run: acli jira auth login --web",
    );

    push(
      issues,
      yield* commandExists("cursor"),
      "cursor CLI on PATH (local agents)",
      "Install Cursor CLI — issue-dinner runs local SDK agents, not cloud",
    );

    if (options.checkGraphite !== false) {
      push(
        issues,
        yield* commandExists("gt"),
        "gt (Graphite) on PATH",
        "Install Graphite CLI or use --no-prep on launch",
      );
    }

    if (options.checkTmux) {
      push(
        issues,
        yield* commandExists("tmux"),
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
        exists
          ? undefined
          : `Fix workspaces.${key} in ~/.config/issue-dinner/config.json`,
      );
      if (!exists) continue;

      const statusOutcome = yield* Effect.either(
        runCommand("git", ["status", "--porcelain"], { cwd }),
      );

      if (statusOutcome._tag === "Left") {
        push(
          issues,
          false,
          `${key}: git status failed`,
          `Check ${cwd} is a git repo`,
        );
        continue;
      }

      const { stdout } = statusOutcome.right;
      let clean = stdout.trim().length === 0;
      if (!clean) {
        const issue = yield* recoveryIssueForWorkspace(
          key,
          options.menuIssues,
          options.config,
        );
        if (issue) {
          const recoveredOutcome = yield* Effect.either(
            recoverDirtyWorkspace(key, cwd, issue.key, issue.summary),
          );
          if (
            recoveredOutcome._tag === "Right" &&
            recoveredOutcome.right.ok
          ) {
            clean = true;
            const recovered = recoveredOutcome.right;
            push(
              issues,
              true,
              `${key}: recovered dirty tree (${recovered.action}${recovered.detail ? ` @ ${recovered.detail}` : ""})`,
            );
            continue;
          }
        }
        push(
          issues,
          true,
          `${key}: working tree has uncommitted changes (dinner will recover at stack prep)`,
        );
        continue;
      }
      push(issues, true, `${key}: working tree clean`);
    }

    if (options.checkGraphite !== false && (yield* commandExists("gt"))) {
      for (const [key, cwd] of Object.entries(options.config.workspaces)) {
        if (!existsSync(cwd)) continue;
        const gtOutcome = yield* Effect.either(
          runCommand("gt", ["log", "short", "--cwd", cwd], { cwd }),
        );
        if (gtOutcome._tag === "Left") {
          push(
            issues,
            false,
            `${key}: Graphite not initialized`,
            `cd ${cwd} && gt init && gt track --parent ${options.stack.graphiteTrunk}`,
          );
        } else {
          push(issues, true, `${key}: Graphite initialized`);
        }
      }
    }

    if (options.validateVerify !== false) {
      const gate = options.config.serveVerifyGate ?? "inner";
      for (const issue of options.menuIssues) {
        if (yield* shouldSkipVerifyPathsForIssue(issue.key)) {
          const status =
            (yield* store.get(issue.key))?.status ?? "done";
          push(
            issues,
            true,
            `${issue.key}: verify paths skipped (${status} in dinner state)`,
          );
          continue;
        }
        const roots = resolveIssueWorkspaces(
          options.config,
          issue.key,
          issue.description,
          issue.summary,
        );
        const validation = yield* validateVerifyCommands(
          options.config,
          issue.key,
          roots.keys,
          { gate },
        );
        for (const v of validation) {
          push(issues, v.ok, `${issue.key}: ${v.message}`, v.fix);
        }
      }
    }

    const ok = issues.every((i) => i.ok);
    return { ok, issues };
  });

function issueKeyFromPreflightMessage(message: string): string | undefined {
  const m = message.match(/^(CPD-\d+):/);
  return m?.[1];
}

export function formatPreflightReport(report: PreflightReport): string {
  const lines = [fg.bold("Preflight checks:"), ""];
  const failures: PreflightExplanation[] = [];

  for (const item of report.issues) {
    const mark = item.ok ? fg.green("✓") : fg.red("✗");
    lines.push(`${mark} ${item.message}`);
    if (!item.ok) {
      const explained = explainPreflightFailure(
        item.message,
        item.fix,
        issueKeyFromPreflightMessage(item.message),
      );
      failures.push(explained);
      lines.push(fg.yellow(`  Problem: ${explained.summary}`));
      for (const step of explained.steps) {
        lines.push(fg.yellow(`    → ${step}`));
      }
    }
  }

  if (!report.ok) {
    lines.push("");
    lines.push(
      fg.bold(
        fg.red("Cannot start serve until the ✗ items above are fixed."),
      ),
    );
    if (failures.length === 1) {
      lines.push(fg.red(`Next step: ${failures[0]!.steps[0]}`));
    }
  }
  return lines.join("\n");
}

export function assertPreflight(report: PreflightReport): void {
  if (report.ok) return;
  const first = report.issues.find((i) => !i.ok);
  const explained = first
    ? explainPreflightFailure(
        first.message,
        first.fix,
        issueKeyFromPreflightMessage(first.message),
      )
    : undefined;
  const hint = explained?.steps[0] ?? "See preflight report above.";
  throw new Error(`Preflight blocked serve. ${hint}`);
}
