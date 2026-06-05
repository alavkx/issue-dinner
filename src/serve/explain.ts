import type { IssueRunRecord } from "../state/store.js";

export interface StoryExplanation {
  whatWentWrong: string;
  whatToDo: string[];
}

export interface PreflightExplanation {
  summary: string;
  steps: string[];
}

/** Turn internal resolution / error strings into plain language. */
export function explainStoryFailure(
  issueKey: string,
  epic: string,
  rec: IssueRunRecord | undefined,
): StoryExplanation {
  if (!rec) {
    return {
      whatWentWrong: `${issueKey} has not been run yet.`,
      whatToDo: [`issue-dinner ${epic} run ${issueKey}`],
    };
  }

  const err = rec.error ?? rec.verifyError ?? "";
  const steps = rec.resolutionSteps ?? [];

  if (
    err.includes("no commands configured") ||
    err.includes("no verify commands") ||
    steps.some(
      (s) =>
        s.includes("no commands configured") ||
        s.includes("quick checks skipped"),
    )
  ) {
    return {
      whatWentWrong: `${issueKey} has no quick automated checks during serve (slow integration tests are deferred to the outer loop).`,
      whatToDo: [
        `Re-run: issue-dinner ${epic} serve --only ${issueKey}`,
        `After the story finishes, run full tests: issue-dinner verify ${issueKey}`,
      ],
    };
  }

  if (
    err.includes("working tree is dirty") ||
    steps.some((s) => s.includes("working tree is dirty") || s.includes("Stack prep failed"))
  ) {
    return {
      whatWentWrong: `Git still had uncommitted changes when the orchestrator tried to switch to the ${issueKey} branch.`,
      whatToDo: [
        `Re-run: issue-dinner ${epic} serve --only ${issueKey} (the orchestrator will try to commit or stash automatically)`,
        `Or manually: in the workspace for this story, run git status, commit or stash, then re-run serve`,
        `If work was stashed: check out the story branch for ${issueKey} and run git stash list`,
      ],
    };
  }

  if (rec.status === "agent_complete" || err.includes("Verify failed")) {
    const testName = err.replace(/^Verify failed:\s*/i, "").trim() || "configured tests";
    return {
      whatWentWrong: `The agent finished ${issueKey}, but automated tests did not pass (${testName}).`,
      whatToDo: [
        `Run tests locally, fix failures, commit, then: issue-dinner verify ${issueKey}`,
        `Or re-run the story: issue-dinner ${epic} run ${issueKey} --force`,
      ],
    };
  }

  if (steps.some((s) => s.includes("Recovery handoff not acceptable"))) {
    return {
      whatWentWrong: `The orchestrator tried to fix a git/stack problem automatically, but the recovery agent did not confirm success.`,
      whatToDo: [
        `Check: issue-dinner ${epic} status --verbose`,
        `Read the transcript path shown for ${issueKey}`,
        `Fix git manually (clean status on the right branch), then: issue-dinner ${epic} serve --only ${issueKey}`,
      ],
    };
  }

  if (
    steps.some(
      (s) =>
        s.includes("Recovery agent canceled") ||
        s.includes("stall timeout"),
    )
  ) {
    return {
      whatWentWrong: `The recovery agent lost its connection to Cursor (stall timeout) while fixing ${issueKey}.`,
      whatToDo: [
        `Re-run: issue-dinner ${epic} serve --only ${issueKey}`,
        `If it keeps timing out, run: issue-dinner ${epic} run ${issueKey} --force`,
      ],
    };
  }

  if (steps.some((s) => s.includes("Recovery run error"))) {
    return {
      whatWentWrong: `An automatic recovery agent run crashed while working on ${issueKey}.`,
      whatToDo: [
        `issue-dinner ${epic} run ${issueKey} --force`,
        `If it keeps failing, fix the underlying error in the transcript and re-run serve`,
      ],
    };
  }

  if (rec.status === "error" && err) {
    return {
      whatWentWrong: err,
      whatToDo: [`issue-dinner ${epic} run ${issueKey} --force`],
    };
  }

  if (rec.status === "verified") {
    return {
      whatWentWrong: `${issueKey} completed successfully.`,
      whatToDo: [],
    };
  }

  return {
    whatWentWrong: `${issueKey} did not finish (status: ${rec.status}).`,
    whatToDo: [`issue-dinner ${epic} status --verbose`, `issue-dinner ${epic} run ${issueKey} --force`],
  };
}

export function explainPreflightFailure(
  message: string,
  fix: string | undefined,
  issueKey?: string,
): PreflightExplanation {
  if (
    (message.includes("no commands configured") ||
      message.includes("no inner verify commands") ||
      message.includes("only slow tests")) &&
    issueKey
  ) {
    return {
      summary: `${issueKey} has no quick test gate for serve — serve will skip fast checks and continue (integration tests run separately).`,
      steps: [
        `Re-run: issue-dinner serve (no setup step required)`,
        `After ${issueKey} lands, run full checks: issue-dinner verify ${issueKey}`,
      ],
    };
  }

  if (message.includes("working tree clean") && fix?.includes("stash")) {
    return {
      summary: "The repo has uncommitted changes before the run starts.",
      steps: [
        "The orchestrator will usually commit or stash these automatically on retry",
        "Or run: cd /path/to/repo && git add -A && git commit -m 'wip'",
        "Then re-run serve",
      ],
    };
  }

  if (message.includes("not on PATH")) {
    return {
      summary: message,
      steps: fix ? [fix] : ["Install the missing tool, then re-run serve"],
    };
  }

  if (message.includes("is not set")) {
    return {
      summary: message,
      steps: fix ? [fix] : ["Set the environment variable, then re-run serve"],
    };
  }

  if (message.includes("missing")) {
    return {
      summary: message,
      steps: fix ? [fix] : ["Fix the test path in config.json, then re-run serve"],
    };
  }

  return {
    summary: message,
    steps: fix ? [fix] : ["Fix the check above, then re-run serve"],
  };
}

/** Skip noise in the resolution timeline (recovery attempt counters). */
export function isResolutionNoise(step: string): boolean {
  return (
    /^Recovery \w+ attempt \d+\/\d+$/.test(step) ||
    step.startsWith("Recovery agent succeeded") ||
    step.startsWith("Programmatic stack recovery")
  );
}
