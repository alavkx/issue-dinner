import type { JiraIssue } from "../jira/acli.js";

export interface PromptContext {
  issue: JiraIssue;
  cwd: string;
  workspaceKey: string;
  relatedPaths?: string[];
}

export function buildAgentPrompt(ctx: PromptContext): string {
  const { issue, cwd, workspaceKey, relatedPaths = [] } = ctx;
  const ac = issue.parsed.acceptanceCriteria
    .map((c, i) => `${i + 1}. ${c}`)
    .join("\n");

  const related =
    relatedPaths.length > 0
      ? `\nRelated repos (read-only context; primary workspace is ${workspaceKey}):\n${relatedPaths.map((p) => `- ${p}`).join("\n")}`
      : "";

  return `You are implementing a Jira vertical slice in a local workspace.

## Issue
- **Key:** ${issue.key}
- **Summary:** ${issue.summary}
- **Status:** ${issue.status}

## Workspace
- **Primary cwd:** ${cwd}
- **Workspace key:** ${workspaceKey}
${related}

## Description
${issue.description}

## Instructions
1. Implement **What to build** and satisfy every acceptance criterion.
2. Follow ADRs and CONTEXT docs referenced in the issue; do not re-debate settled design.
3. Run relevant tests (unit/integration) and fix failures before finishing.
4. Do **not** create git commits unless the user explicitly asked for commits in this run.
5. Do **not** push to remote.
6. When done, reply with a short summary: what changed, tests run, and any follow-ups for other repos.

## Acceptance criteria
${ac || "(none parsed — use Description section)"}
`;
}
