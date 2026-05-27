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
      ? `\nRelated repos (read-only context; switch cwd or note follow-ups if the slice requires changes there):\n${relatedPaths.map((p) => `- ${p}`).join("\n")}`
      : "";

  return `You are implementing one Jira **vertical slice** in a local workspace.

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

## How to work (TDD — vertical slices only)

Do **not** write all tests then all code (horizontal slices). Use **tracer bullets**:

1. Pick the **first acceptance criterion** (or smallest behavior that proves the slice path).
2. **RED:** add one test through a **public interface** (API route, exported function, integration test against real HTTP/DB boundaries — not private helpers).
3. **GREEN:** minimal code until that test passes.
4. Repeat one criterion at a time until the slice is done.
5. **Refactor** only while green.

Tests must describe **observable behavior**, survive refactors, and use the project's domain language (see CONTEXT.md / ADRs in the issue).

If the slice spans multiple repos (OpenAPI, SDK, backend, frontend), complete each repo in TDD order; list any repo you could not modify in **Suggested follow-ups**.

## Quality
- Follow ADRs and CONTEXT docs; do not re-debate settled design.
- No placeholder TODOs or \`not implemented\` throws in production paths.
- Run the tests you add plus relevant existing suites before finishing.
- Do **not** git commit or push unless explicitly asked.

## Final message (required handoff)

Your **last message** is the only output issue-dinner reads. Use exactly:

## Status
success | partial | blocked

## Verification
unit-test-verified | live-ui-verified | type-check-only | not-verified

Pick the strongest claim supported by what you **ran** (not diff-reading alone).

## Measurements
- <metric>: <before> → <after>

One line per quantitative AC, or \`(none)\` if none apply.

## What I did
- <summary per area/file>

## Suggested follow-ups
- <other repos or tasks>

## Acceptance criteria (checklist)
${ac || "(use Description section)"}
`;
}
