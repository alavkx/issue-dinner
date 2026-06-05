import type { JiraIssue } from "../jira/acli.js";
import type { IssueRunRecord } from "../state/store.js";
import { StateStore } from "../state/store.js";
import type { StackConfig } from "../stack/stack-config.js";
import { storyBranchName } from "../stack/names.js";
import { serveLogPath } from "./log.js";
import * as FileSystem from "@effect/platform/FileSystem";
import { sessionHistoryPath } from "./transcript.js";
import { explainStoryFailure } from "./explain.js";
import {
  countStoryFailures,
  findFirstStoryFailure,
  issueFailed,
  primaryFailureMessage,
  type ServeHaltInfo,
} from "./failures.js";
import {
  countRecoveryAttempts,
  extractHandoffExcerpt,
  extractManualVerificationItems,
  formatDuration,
  formatKeyList,
  meaningfulResolutionSteps,
  wasRecovered,
} from "./summary-helpers.js";
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

export interface ServeSessionInfo {
  serveStartedAt?: string;
  selfHeal?: boolean;
  processedThisSession?: ReadonlyArray<string>;
  skippedAlreadyVerified?: ReadonlyArray<string>;
  pendingHealContributions?: ReadonlyArray<string>;
}

export interface ServeSummaryOptions {
  epic: string;
  stack: StackConfig;
  issues: JiraIssue[];
  held: Array<{ key: string; reason: string }>;
  skipped: string[];
  logPath?: string;
  session?: ServeSessionInfo;
  /** Explicit halt from serve loop (crash, dirty gate, story order). */
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

function storyBadge(rec: IssueRunRecord | undefined, failedStory: boolean): string {
  if (failedStory) return fg.red("FAILED");
  if (wasRecovered(rec)) return fg.yellow("verified (recovered)");
  return statusBadge(rec?.status ?? "pending");
}

export function printServeHalt(halt: ServeHaltInfo, epic: string): void {
  const explained = explainStoryFailure(halt.issueKey, epic, {
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
    fg.bold(fg.red("║  RUN HALTED — fix this, then run serve again          ║")),
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

const countSessionRecoveryAttempts = (
  issueKeys: ReadonlyArray<string>,
  records: ReadonlyMap<string, IssueRunRecord | undefined>,
): number =>
  issueKeys.reduce(
    (total, key) => total + countRecoveryAttempts(records.get(key)?.resolutionSteps),
    0,
  );

const allStoriesVerified = (
  issues: JiraIssue[],
  records: ReadonlyMap<string, IssueRunRecord | undefined>,
): boolean =>
  issues.every((issue) => {
    const rec = records.get(issue.key);
    return rec?.status === "verified" || rec?.status === "finished";
  });

export const printServeSummary = (
  options: ServeSummaryOptions,
): Effect.Effect<void, import("@effect/platform/Error").PlatformError, StateStore | FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const store = yield* StateStore;
    const { epic, stack, issues, held, skipped } = options;
    const session = options.session ?? {};
    const processedThisSession = session.processedThisSession ?? [];
    const skippedAlreadyVerified = session.skippedAlreadyVerified ?? skipped;
    const logPath = options.logPath ?? (yield* serveLogPath(epic));
    const counts = yield* countByStatus(issues);
    counts.held = held.length;
    counts.skipped += skipped.length;
    const failed = yield* countStoryFailures(issues);
    const halt =
      options.halt ??
      (failed > 0 ? yield* findFirstStoryFailure(issues) : undefined);

    const records = new Map<string, IssueRunRecord | undefined>();
    for (const issue of issues) {
      records.set(issue.key, yield* store.get(issue.key));
    }

    const sessionRecoveryAttempts = countSessionRecoveryAttempts(
      processedThisSession.length > 0 ? processedThisSession : issues.map((i) => i.key),
      records,
    );

    console.log("");
    console.log(
      fg.bold(fg.cyan("══════════════════════════════════════════════════════════")),
    );
    console.log(fg.bold(fg.cyan(`Run summary — ${epic}`)));
    console.log(
      fg.bold(fg.cyan("══════════════════════════════════════════════════════════")),
    );
    const failTotal = failed + counts.held;
    const skippedLabel =
      skippedAlreadyVerified.length > 0
        ? `skipped (already verified): ${skippedAlreadyVerified.length} [${formatKeyList(skippedAlreadyVerified)}]`
        : `skipped (already verified): ${counts.skipped}`;
    console.log(
      `  ${fg.green(`verified: ${counts.verified}`)}   ${fg.yellow(`agent_complete: ${counts.agentComplete}`)}   ${fg.red(`failed: ${failTotal}`)} (${fg.red(`error: ${counts.error}`)} + ${fg.red(`blocked: ${counts.blocked}`)})   held: ${counts.held}   ${skippedLabel}`,
    );
    if (processedThisSession.length > 0) {
      console.log(
        fg.dim(
          `  processed this session: ${processedThisSession.length} [${formatKeyList(processedThisSession)}]`,
        ),
      );
    }
    const sessionParts: string[] = [];
    if (session.serveStartedAt) {
      sessionParts.push(`duration: ${formatDuration(session.serveStartedAt)}`);
    }
    if (session.selfHeal !== undefined) {
      sessionParts.push(`self-heal: ${session.selfHeal ? "on" : "off"}`);
    }
    if (sessionRecoveryAttempts > 0) {
      sessionParts.push(`recovery attempts: ${sessionRecoveryAttempts}`);
    }
    const pendingHeals = session.pendingHealContributions ?? [];
    if (pendingHeals.length > 0) {
      sessionParts.push(`heal patches pending: ${pendingHeals.length}`);
    }
    if (sessionParts.length > 0) {
      console.log(fg.dim(`  session: ${sessionParts.join("   ")}`));
    }
    if (logPath) console.log(fg.dim(`  log: ${logPath}`));
    console.log(fg.dim(`  history: ${sessionHistoryPath(epic)}`));
    console.log("");

    for (const issue of issues) {
      const rec = records.get(issue.key);
      const expectedBranch = storyBranchName(stack.prefix, issue.key);
      const status = rec?.status ?? "pending";
      const failedStory = issueFailed(rec);
      const paint = failedStory ? fg.red : statusColor(status);
      const badge = storyBadge(rec, failedStory);
      console.log(`${paint(issue.key)}  ${badge}  ${issue.summary}`);

      const branches = rec?.branches ?? {};
      const branchEntries = Object.entries(branches);
      if (branchEntries.length > 0) {
        for (const [ws, branch] of branchEntries) {
          const sha = rec?.commits?.[ws];
          const shaLabel = sha ? ` @ ${sha}` : fg.dim(" (no commit recorded)");
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

      const excerpt = extractHandoffExcerpt(rec?.resultPreview);
      if (excerpt) {
        console.log(fg.dim(`    outcome: ${excerpt}`));
      }

      const manualChecks = extractManualVerificationItems(rec?.resultPreview);
      for (const item of manualChecks) {
        console.log(fg.yellow(`    ⚠ manual verification pending: ${item}`));
      }

      if (wasRecovered(rec)) {
        const attempts = countRecoveryAttempts(rec?.resolutionSteps);
        console.log(
          fg.yellow(
            `    recovered after ${attempts} recovery attempt${attempts === 1 ? "" : "s"}`,
          ),
        );
        const usefulSteps = meaningfulResolutionSteps(rec?.resolutionSteps);
        if (usefulSteps.length > 0) {
          console.log(fg.dim(`    resolution: ${usefulSteps.at(-1)}`));
        }
      }

      if (failedStory && rec) {
        const explained = explainStoryFailure(issue.key, epic, rec);
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
      const usefulSteps = meaningfulResolutionSteps(rec?.resolutionSteps);
      if (usefulSteps.length > 0 && failedStory) {
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

    const epicComplete = !halt && allStoriesVerified(issues, records);
    const next = yield* suggestNextCommand(epic, issues, held, epicComplete);
    if (epicComplete) {
      console.log(fg.green("All stories complete."));
      console.log(
        fg.dim("Push story branches and open PRs when ready, then run integration verify as needed."),
      );
    }
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
  epicComplete: boolean,
): Effect.Effect<string | undefined, never, StateStore> =>
  Effect.gen(function* () {
    if (epicComplete) {
      const others = issues.slice(1).map((i) => i.key);
      if (issues.length === 1) {
        return `issue-dinner verify ${issues[0]!.key}`;
      }
      return `issue-dinner verify ${issues[0]!.key}  # then: ${others.join(", ")}`;
    }
    const store = yield* StateStore;
    for (const issue of issues) {
      const rec = yield* store.get(issue.key);
      if (issueFailed(rec)) {
        const st = rec?.status;
        if (st === "agent_complete") {
          return `issue-dinner verify ${issue.key}`;
        }
        return `issue-dinner ${epic} run ${issue.key} --force`;
      }
    }
    const nextHeld = held[0];
    if (nextHeld) {
      return `issue-dinner ${epic} run ${nextHeld.key} --force`;
    }
    for (const issue of issues) {
      if (!(yield* store.isDone(issue.key))) {
        return `issue-dinner ${epic} run ${issue.key}`;
      }
    }
    return undefined;
  });
