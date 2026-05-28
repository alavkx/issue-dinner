import type { JiraIssue } from "../jira/acli.js";
import type { IssueRunRecord } from "../state/store.js";
import { StateStore } from "../state/store.js";
import type { StackConfig } from "../stack/stack-config.js";
import { storyBranchName } from "../stack/names.js";
import { serveLogPath } from "./log.js";
import { sessionHistoryPath } from "./transcript.js";
import { explainCourseFailure, isResolutionNoise } from "./explain.js";
import {
  countMenuFailures,
  findFirstMenuFailure,
  issueFailed,
  primaryFailureMessage,
  type ServeHaltInfo,
} from "./failures.js";
import { fg, statusBadge, statusColor } from "../ui/theme.js";
import * as Effect from "effect/Effect";

export interface ServeSummaryCounts {
  verified: number;
  agentComplete: number;
  error: number;
  blocked: number;
  held: number;
  skipped: number;
  pending: number;
}

export interface ServeSummaryOptions {
  epic: string;
  stack: StackConfig;
  issues: JiraIssue[];
  held: Array<{ key: string; reason: string }>;
  skipped: string[];
  logPath?: string;
  /** Explicit halt from serve loop (crash, dirty gate, menu order). */
  halt?: ServeHaltInfo;
}

const countByStatus = (
  issues: JiraIssue[],
): Effect.Effect<ServeSummaryCounts, never, StateStore> =>
  Effect.gen(function* () {
    const store = yield* StateStore;
    const counts: ServeSummaryCounts = {
      verified: 0,
      agentComplete: 0,
      error: 0,
      blocked: 0,
      held: 0,
      skipped: 0,
      pending: 0,
    };
    for (const issue of issues) {
      const rec = yield* store.get(issue.key);
      if (!rec) {
        counts.pending += 1;
        continue;
      }
      if (
        issueFailed(rec) &&
        rec.status !== "error" &&
        rec.status !== "agent_complete"
      ) {
        counts.blocked += 1;
        continue;
      }
      switch (rec.status) {
        case "verified":
        case "finished":
          counts.verified += 1;
          break;
        case "agent_complete":
          counts.agentComplete += 1;
          break;
        case "error":
          counts.error += 1;
          break;
        case "skipped":
          counts.skipped += 1;
          break;
        default:
          counts.pending += 1;
      }
    }
    return counts;
  });

function displayFailure(rec: IssueRunRecord): string | undefined {
  if (rec.error) return rec.error.slice(0, 200);
  if (rec.verifyError) return rec.verifyError;
  if (issueFailed(rec)) return primaryFailureMessage(rec);
  return undefined;
}

export function printServeHalt(halt: ServeHaltInfo, epic: string): void {
  const explained = explainCourseFailure(halt.issueKey, epic, {
    issueKey: halt.issueKey,
    summary: halt.summary,
    status: "error",
    error: halt.reason,
  });
  console.log("");
  console.log(
    fg.bold(fg.red("╔══════════════════════════════════════════════════════════╗")),
  );
  console.log(
    fg.bold(fg.red("║  DINNER HALTED — fix this, then run serve again          ║")),
  );
  console.log(
    fg.bold(fg.red("╚══════════════════════════════════════════════════════════╝")),
  );
  console.log(fg.red(`  ${halt.issueKey}: ${halt.summary}`));
  console.log(fg.red(`  What went wrong: ${explained.whatWentWrong}`));
  if (explained.whatToDo.length > 0) {
    console.log(fg.yellow("  What to do:"));
    for (const step of explained.whatToDo) {
      console.log(fg.yellow(`    → ${step}`));
    }
  }
  if (halt.transcriptPath) {
    console.log(fg.dim(`  Agent log: ${halt.transcriptPath}`));
  }
  console.log("");
}

export const printServeSummary = (
  options: ServeSummaryOptions,
): Effect.Effect<void, never, StateStore> =>
  Effect.gen(function* () {
    const store = yield* StateStore;
    const { epic, stack, issues, held, skipped } = options;
    const logPath = options.logPath ?? serveLogPath(epic);
    const counts = yield* countByStatus(issues);
    counts.held = held.length;
    counts.skipped += skipped.length;
    const failed = yield* countMenuFailures(issues);
    const halt =
      options.halt ??
      (failed > 0 ? yield* findFirstMenuFailure(issues) : undefined);

    console.log("");
    console.log(
      fg.bold(fg.cyan("══════════════════════════════════════════════════════════")),
    );
    console.log(fg.bold(fg.cyan(`Dinner summary — ${epic}`)));
    console.log(
      fg.bold(fg.cyan("══════════════════════════════════════════════════════════")),
    );
    const failTotal = failed + counts.held;
    console.log(
      `  ${fg.green(`verified: ${counts.verified}`)}   ${fg.yellow(`agent_complete: ${counts.agentComplete}`)}   ${fg.red(`failed: ${failTotal}`)} (${fg.red(`error: ${counts.error}`)} + ${fg.red(`blocked: ${counts.blocked}`)})   held: ${counts.held}   skipped: ${counts.skipped}`,
    );
    if (logPath) console.log(fg.dim(`  log: ${logPath}`));
    console.log(fg.dim(`  history: ${sessionHistoryPath(epic)}`));
    console.log("");

    for (const issue of issues) {
      const rec = yield* store.get(issue.key);
      const expectedBranch = storyBranchName(stack.prefix, issue.key);
      const status = rec?.status ?? "pending";
      const failedCourse = issueFailed(rec);
      const paint = failedCourse ? fg.red : statusColor(status);
      const badge = failedCourse ? fg.red("FAILED") : statusBadge(status);
      console.log(`${paint(issue.key)}  ${badge}  ${issue.summary}`);

      const branches = rec?.branches ?? {};
      const branchEntries = Object.entries(branches);
      if (branchEntries.length > 0) {
        for (const [ws, branch] of branchEntries) {
          const sha = rec?.commits?.[ws];
          const shaLabel = sha ? ` @ ${sha}` : "";
          console.log(`    ${ws}: ${branch}${shaLabel}`);
        }
      } else {
        console.log(`    (expected) ${expectedBranch}`);
      }

      if (rec?.handoffVerification) {
        console.log(
          `    handoff: ${rec.handoffStatus} / ${rec.handoffVerification}`,
        );
      }
      if (failedCourse && rec) {
        const explained = explainCourseFailure(issue.key, epic, rec);
        console.log(fg.red(`    What went wrong: ${explained.whatWentWrong}`));
        if (explained.whatToDo.length > 0) {
          console.log(fg.yellow("    What to do:"));
          for (const step of explained.whatToDo) {
            console.log(fg.yellow(`      → ${step}`));
          }
        }
      } else if (rec) {
        const failureLine = displayFailure(rec);
        if (failureLine) {
          console.log(fg.red(`    ✗ ${failureLine}`));
        }
      }
      const usefulSteps = (rec?.resolutionSteps ?? []).filter(
        (s) => !isResolutionNoise(s),
      );
      if (usefulSteps.length > 0 && failedCourse) {
        console.log(fg.dim(`    Log: ${usefulSteps.at(-1)}`));
      }
      if (rec?.transcriptPath) {
        console.log(fg.dim(`    transcript: ${rec.transcriptPath}`));
      }
      console.log("");
    }

    if (held.length > 0) {
      console.log("Held (blockers):");
      for (const h of held) {
        console.log(`  ${h.key}: ${h.reason}`);
      }
      console.log("");
    }

    const next = yield* suggestNextCommand(epic, issues, held);
    if (next) {
      console.log(`Next: ${next}`);
    }
    console.log(`Status: issue-dinner ${epic} status --verbose`);
    console.log("══════════════════════════════════════════════════════════");

    if (halt) {
      printServeHalt(halt, epic);
    } else {
      console.log("");
    }
  });

const suggestNextCommand = (
  epic: string,
  issues: JiraIssue[],
  held: { key: string }[],
): Effect.Effect<string | undefined, never, StateStore> =>
  Effect.gen(function* () {
    const store = yield* StateStore;
    for (const issue of issues) {
      const rec = yield* store.get(issue.key);
      if (issueFailed(rec)) {
        const st = rec?.status;
        if (st === "agent_complete") {
          return `issue-dinner verify ${issue.key}`;
        }
        return `issue-dinner ${epic} cook ${issue.key} --force`;
      }
    }
    const nextHeld = held[0];
    if (nextHeld) {
      return `issue-dinner ${epic} cook ${nextHeld.key} --force`;
    }
    for (const issue of issues) {
      if (!(yield* store.isDone(issue.key))) {
        return `issue-dinner ${epic} cook ${issue.key}`;
      }
    }
    return undefined;
  });
