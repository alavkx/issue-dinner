import type { JiraIssue } from "../jira/acli.js";
import type { IssueRunRecord, StateStore } from "../state/store.js";
import type { StackConfig } from "../stack/stack-config.js";
import { storyBranchName } from "../stack/names.js";
import { serveLogPath } from "./log.js";

export interface ServeSummaryCounts {
  verified: number;
  agentComplete: number;
  error: number;
  held: number;
  skipped: number;
  pending: number;
}

export interface ServeSummaryOptions {
  epic: string;
  stack: StackConfig;
  issues: JiraIssue[];
  store: StateStore;
  held: Array<{ key: string; reason: string }>;
  skipped: string[];
  logPath?: string;
}

function countByStatus(records: IssueRunRecord[]): ServeSummaryCounts {
  const counts: ServeSummaryCounts = {
    verified: 0,
    agentComplete: 0,
    error: 0,
    held: 0,
    skipped: 0,
    pending: 0,
  };
  for (const rec of records) {
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
}

export function printServeSummary(options: ServeSummaryOptions): void {
  const { epic, stack, issues, store, held, skipped } = options;
  const logPath = options.logPath ?? serveLogPath(epic);
  const records = issues
    .map((i) => store.get(i.key))
    .filter(Boolean) as IssueRunRecord[];
  const counts = countByStatus(records);
  counts.held = held.length;
  counts.skipped += skipped.length;

  console.log("\n══════════════════════════════════════════════════════════");
  console.log(`Dinner summary — ${epic}`);
  console.log("══════════════════════════════════════════════════════════");
  console.log(
    `  verified: ${counts.verified}   agent_complete: ${counts.agentComplete}   error: ${counts.error}   held: ${counts.held}   skipped: ${counts.skipped}`,
  );
  if (logPath) console.log(`  log: ${logPath}`);
  console.log("");

  for (const issue of issues) {
    const rec = store.get(issue.key);
    const expectedBranch = storyBranchName(stack.prefix, issue.key);
    const status = rec?.status ?? "pending";
    console.log(`${issue.key}  ${status.padEnd(14)}  ${issue.summary}`);

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
    if (rec?.verifyError) {
      console.log(`    verify: ${rec.verifyError}`);
    } else if (rec?.error && status === "error") {
      console.log(`    error: ${rec.error.slice(0, 160)}`);
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

  const next = suggestNextCommand(epic, issues, store, held);
  if (next) {
    console.log(`Next: ${next}`);
  }
  console.log(`Status: issue-dinner ${epic} status --verbose`);
  console.log("══════════════════════════════════════════════════════════\n");
}

function suggestNextCommand(
  epic: string,
  issues: JiraIssue[],
  store: StateStore,
  held: { key: string }[],
): string | undefined {
  const failed = issues.find((i) => store.get(i.key)?.status === "error");
  if (failed) {
    return `issue-dinner ${epic} cook ${failed.key} --force`;
  }
  const verifyFail = issues.find(
    (i) => store.get(i.key)?.status === "agent_complete",
  );
  if (verifyFail) {
    return `issue-dinner verify ${verifyFail.key}  # or cook ${verifyFail.key} --force`;
  }
  const nextHeld = held[0];
  if (nextHeld) {
    return `issue-dinner ${epic} cook ${nextHeld.key} --force`;
  }
  const pending = issues.find((i) => !store.isDone(i.key));
  if (pending) {
    return `issue-dinner ${epic} cook ${pending.key}`;
  }
  return undefined;
}
