import type { IssueWorkspaces } from "../config/workspaces.js";
import type { JiraIssue } from "../jira/acli.js";

export type RecoveryKind =
  | "stack_prep"
  | "verify"
  | "commit"
  | "handoff"
  | "agent_error"
  | "interrupted";

export function buildRecoveryPrompt(options: {
  issue: JiraIssue;
  roots: IssueWorkspaces;
  kind: RecoveryKind;
  detail: string;
  verifyOutput?: string;
  attempt: number;
  maxAttempts: number;
}): string {
  const { issue, roots, kind, detail, verifyOutput, attempt, maxAttempts } =
    options;
  const ws = roots.keys
    .map((k, i) => `- ${k}: ${roots.cwds[i]}`)
    .join("\n");

  const kindGuide: Record<RecoveryKind, string> = {
    stack_prep: `Graphite/git stack prep failed before the story agent could run.
Fix ONLY workspace/git state (clean trees, correct branch checkout, \`gt restack\` if needed).
Do NOT implement ${issue.key} product code yet.`,
    verify: `Issue-dinner verify commands failed after your implementation pass.
Read the failure output, fix tests/code until verify would pass, then hand off again.`,
    commit: `issue-dinner could not commit WIP on the story branch (often pre-commit hooks).
Fix hook failures, leave a clean committable tree, then hand off with Status: success.`,
    handoff: `Your previous run did not produce an acceptable handoff block.`,
    agent_error: `The Cursor agent run ended with an error.`,
    interrupted: `A previous serve was interrupted while this issue was running.`,
  };

  return `## Recovery pass (${attempt}/${maxAttempts}) — ${issue.key}

You are in **recovery mode** for issue-dinner. ${kindGuide[kind]}

### Failure
\`\`\`
${detail.trim()}
\`\`\`
${verifyOutput ? `\n### Verify output\n\`\`\`\n${verifyOutput.slice(0, 8000)}\n\`\`\`\n` : ""}

### Workspaces
${ws}

### Rules
- Use the Cursor SDK / shell / git / graphite tools available locally.
- Resolve the failure yourself before giving up.
- For commit recovery: you MAY \`git add\` and \`git commit\` to fix hook failures on the story branch.
- Otherwise do not push; issue-dinner commits WIP after a successful agent pass when hooks pass.
- When fixed, end with the standard handoff (Status / Verification / What I did).

### Original summary
${issue.summary}
`;
}
