import type { JiraIssue } from "../jira/acli.js";
import type { IssueRunRecord, StateStore } from "../state/store.js";

const FAILURE_STEP_MARKERS = [
  "Stack prep failed",
  "Recovery exhausted",
  "handoff not acceptable",
  "WIP commit failed",
  "Verify failed:",
  "Agent run error:",
  "fatal error",
] as const;

/** Course did not reach verified — includes agent_complete and failed pending. */
export function issueFailed(rec: IssueRunRecord | undefined): boolean {
  if (!rec) return false;
  if (rec.status === "error" || rec.status === "agent_complete") return true;
  if (rec.error || rec.verifyError) return true;
  if (rec.status === "pending" || rec.status === "running") {
    const steps = rec.resolutionSteps ?? [];
    return steps.some((s) =>
      FAILURE_STEP_MARKERS.some((m) => s.includes(m)),
    );
  }
  return false;
}

export function primaryFailureMessage(rec: IssueRunRecord): string {
  if (rec.error) return rec.error;
  if (rec.verifyError) return rec.verifyError;
  const steps = rec.resolutionSteps ?? [];
  const priority = [
    "Stack prep failed",
    "WIP commit failed",
    "Verify failed:",
    "Recovery exhausted",
  ];
  for (const marker of priority) {
    const hit = steps.find((s) => s.includes(marker));
    if (hit) return hit;
  }
  for (let i = steps.length - 1; i >= 0; i--) {
    const s = steps[i]!;
    if (FAILURE_STEP_MARKERS.some((m) => s.includes(m))) return s;
  }
  if (rec.status === "agent_complete") {
    return "Agent phase OK — inner verify did not pass";
  }
  return `Course stuck in ${rec.status}`;
}

export interface ServeHaltInfo {
  issueKey: string;
  summary: string;
  reason: string;
  transcriptPath?: string;
}

export function findFirstMenuFailure(
  issues: JiraIssue[],
  store: StateStore,
): ServeHaltInfo | undefined {
  for (const issue of issues) {
    const rec = store.get(issue.key);
    if (!issueFailed(rec)) continue;
    return {
      issueKey: issue.key,
      summary: issue.summary,
      reason: primaryFailureMessage(rec!),
      transcriptPath: rec?.transcriptPath,
    };
  }
  return undefined;
}

export function countMenuFailures(
  issues: JiraIssue[],
  store: StateStore,
): number {
  return issues.filter((i) => issueFailed(store.get(i.key))).length;
}
