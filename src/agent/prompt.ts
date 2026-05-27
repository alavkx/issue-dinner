import type { IssueWorkspaces } from "../config/workspaces.js";
import type { JiraIssue } from "../jira/acli.js";

export interface PromptContext {
  issue: JiraIssue;
  roots: IssueWorkspaces;
}

function formatWorkspaceSection(roots: IssueWorkspaces): string {
  if (roots.keys.length === 1) {
    return `- **Workspace:** ${roots.keys[0]}
- **cwd:** ${roots.cwds[0]}`;
  }
  const lines = roots.keys.map((key, i) => `- **${key}:** ${roots.cwds[i]}`);
  return `- **Multi-root workspace** (Cursor SDK local \`cwd\` array — you may read and write in all roots):
${lines.join("\n")}
- **Primary key:** ${roots.primaryKey}`;
}

export function buildAgentPrompt(ctx: PromptContext): string {
  const { issue, roots } = ctx;
  const ac = issue.parsed.acceptanceCriteria
    .map((c, i) => `${i + 1}. ${c}`)
    .join("\n");

  return `You are implementing one Jira **vertical slice** across a multi-root local workspace when configured.

## Issue
- **Key:** ${issue.key}
- **Summary:** ${issue.summary}
- **Status:** ${issue.status}

## Workspace
${formatWorkspaceSection(roots)}

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

When multiple roots are listed, implement the slice **in repo order** (e.g. OpenAPI → SDK regen → backend → frontend tests). Do not defer cross-repo work to follow-ups unless blocked by environment.

## Quality
- Follow ADRs and CONTEXT docs; do not re-debate settled design.
- No placeholder TODOs or \`not implemented\` throws in production paths.
- Run the tests you add plus relevant existing suites in **each** root you touch before finishing.
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
- <summary per repo/root>

## Suggested follow-ups
- <only if truly blocked>

## Acceptance criteria (checklist)
${ac || "(use Description section)"}
`;
}
