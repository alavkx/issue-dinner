import type { JiraIssue } from "../jira/acli.js";
import type { IssueRunRecord } from "../state/store.js";
import { StateStore } from "../state/store.js";
import * as Effect from "effect/Effect";

const FAILURE_STEP_MARKERS = [
  "Stack prep failed",
  "Recovery exhausted",
  "handoff not acceptable",
  "WIP commit failed",
  "Verify failed:",
  "Agent run error:",
  "fatal error",
] as const;

/** Story did not reach verified — includes agent_complete and failed pending. */
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
  return `Story stuck in ${rec.status}`;
}

export interface ServeHaltInfo {
  issueKey: string;
  summary: string;
  reason: string;
  transcriptPath?: string;
}

export const findFirstStoryFailure = (
  issues: JiraIssue[],
): Effect.Effect<ServeHaltInfo | undefined, never, StateStore> =>
  Effect.gen(function* () {
    const store = yield* StateStore;
    for (const issue of issues) {
      const rec = yield* store.get(issue.key);
      if (!issueFailed(rec)) continue;
      return {
        issueKey: issue.key,
        summary: issue.summary,
        reason: primaryFailureMessage(rec!),
        transcriptPath: rec?.transcriptPath,
      };
    }
    return undefined;
  });

export const countStoryFailures = (
  issues: JiraIssue[],
): Effect.Effect<number, never, StateStore> =>
  Effect.gen(function* () {
    const store = yield* StateStore;
    let count = 0;
    for (const issue of issues) {
      const rec = yield* store.get(issue.key);
      if (issueFailed(rec)) count += 1;
    }
    return count;
  });
