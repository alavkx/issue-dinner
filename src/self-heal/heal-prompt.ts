import type { JiraIssue } from "../jira/acli.js";
import type { HealTriggerKind } from "./heal-resume.js";

/** Agent includes this when the failure is not an issue-dinner source bug. */
export const HEAL_DECLINE_MARKER = "NO_HEAL";

export function buildHealPrompt(options: {
  issue: JiraIssue;
  toolRoot: string;
  trigger: HealTriggerKind;
  detail: string;
  verifyOutput?: string;
  attempt: number;
  maxAttempts: number;
}): string {
  const { issue, toolRoot, trigger, detail, verifyOutput, attempt, maxAttempts } =
    options;

  const triggerGuide: Record<HealTriggerKind, string> = {
    orchestration:
      "issue-dinner threw while orchestrating this story — fix the CLI source.",
    agent_error:
      "The story agent failed; if the root cause is issue-dinner (not the project), fix the CLI source.",
    verify:
      "Verify failed; if issue-dinner's verify wiring or tooling is wrong, fix the CLI source.",
    recovery_exhausted:
      "Workspace recovery did not help — the blocker may be in issue-dinner itself.",
    handoff:
      "Handoff parsing failed; if issue-dinner mishandled the agent output, fix the CLI source.",
    commit:
      "Commit orchestration failed; if issue-dinner's git integration is wrong, fix the CLI source.",
    inline:
      "The story agent edited issue-dinner but inline validation failed — fix the CLI source.",
  };

  return `## Heal pass (${attempt}/${maxAttempts}) — issue-dinner self-heal

You are the **heal agent**. Your only job is to fix **issue-dinner** (the CLI tool), not the Jira slice in project repos.

### Context
- **Story blocked:** ${issue.key} — ${issue.summary}
- **Trigger:** ${triggerGuide[trigger]}
- **issue-dinner root (your workspace):** \`${toolRoot}\`

### Failure signal
\`\`\`
${detail.trim()}
\`\`\`
${verifyOutput ? `\n### Verify output\n\`\`\`\n${verifyOutput.slice(0, 8000)}\n\`\`\`\n` : ""}

### How to work
1. Edit \`src/**/*.ts\` under \`${toolRoot}\` directly using file tools — **do not** write JSON patch manifests.
2. Make minimal, focused fixes for the failure above.
3. Typecheck errors are expected while iterating — issue-dinner will feed compiler output back to you.
4. Do **not** touch project repos under other workspace paths.
5. If this failure is **not** fixable in issue-dinner source, reply with exactly: \`${HEAL_DECLINE_MARKER}\` and a one-line reason.

When you believe the fix is complete, end with a short summary of files changed and what you fixed.
`;
}

export function buildHealTypecheckPrompt(options: {
  errors: string;
  iteration: number;
  maxIterations: number;
}): string {
  return `## Heal — typecheck feedback (${options.iteration}/${options.maxIterations})

\`npm run typecheck\` still reports errors. Fix issue-dinner \`src/**/*.ts\` until typecheck passes.

\`\`\`
${options.errors.trim()}
\`\`\`
`;
}

export function buildHealBuildPrompt(options: {
  errors: string;
  iteration: number;
  maxIterations: number;
}): string {
  return `## Heal — build feedback (${options.iteration}/${options.maxIterations})

\`npm run build\` failed after typecheck passed. Fix issue-dinner \`src/**/*.ts\`.

\`\`\`
${options.errors.trim()}
\`\`\`
`;
}

export function buildInlineHealTypecheckPrompt(options: {
  toolRoot: string;
  errors: string;
  iteration: number;
  maxIterations: number;
}): string {
  return `## issue-dinner inline heal — typecheck feedback (${options.iteration}/${options.maxIterations})

You edited issue-dinner source under \`${options.toolRoot}\`. Typecheck must pass before this story continues.

Fix only \`src/**/*.ts\` under that root. Do not change project repos for this step.

\`\`\`
${options.errors.trim()}
\`\`\`
`;
}

export function buildInlineHealBuildPrompt(options: {
  toolRoot: string;
  errors: string;
  iteration: number;
  maxIterations: number;
}): string {
  return `## issue-dinner inline heal — build feedback (${options.iteration}/${options.maxIterations})

Typecheck passed but \`npm run build\` failed for issue-dinner under \`${options.toolRoot}\`.

Fix only \`src/**/*.ts\` under that root.

\`\`\`
${options.errors.trim()}
\`\`\`
`;
}

export function buildPostHealStoryResumePrompt(options: {
  issue: JiraIssue;
  fixSummary: string;
}): string {
  return `## issue-dinner was fixed — continue your story

While you were working **${options.issue.key}**, issue-dinner patched its own source to fix a tooling bug. The failure you may have seen is **resolved** — do not retry or debug that old error.

### What was fixed in issue-dinner
${options.fixSummary.trim()}

### Your task now
Continue implementing **${options.issue.key}** — ${options.issue.summary}.

Pick up the vertical slice where you left off. Run inner verify before your final handoff.
`;
}

export function agentDeclinedHeal(text: string): boolean {
  return text.includes(HEAL_DECLINE_MARKER);
}

export function extractHealSummary(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return "issue-dinner source was patched.";
  const lines = trimmed.split("\n").filter((l) => !l.includes(HEAL_DECLINE_MARKER));
  return lines.slice(-8).join("\n").slice(0, 2000);
}
