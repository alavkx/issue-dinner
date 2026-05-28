import type { MachineConfig } from "../config.js";
import type { IssueWorkspaces } from "../config/workspaces.js";
import type { JiraIssue } from "../jira/acli.js";
import { formatVerifyCommandsForPrompt } from "../verify/format.js";
import type { ResolvedVerifyCommand } from "../verify/resolve.js";

export interface PromptContext {
  issue: JiraIssue;
  roots: IssueWorkspaces;
  config: MachineConfig;
  verifyCommands: ResolvedVerifyCommand[];
  selfHeal?: boolean;
  kitchenRoot?: string;
}

function formatWorkspaceSection(roots: IssueWorkspaces): string {
  if (roots.keys.length === 1) {
    return `- **Workspace:** ${roots.keys[0]}
- **cwd:** ${roots.cwds[0]}`;
  }
  const lines = roots.keys.map((key, i) => `- **${key}:** ${roots.cwds[i]}`);
  return `- **Multi-root workspace** (Cursor SDK **local** agent — \`cwd\` array; not cloud):
${lines.join("\n")}
- **Primary key:** ${roots.primaryKey}`;
}

export function buildAgentPrompt(ctx: PromptContext): string {
  const { issue, roots, config, verifyCommands, selfHeal, kitchenRoot } = ctx;
  const ac = issue.parsed.acceptanceCriteria
    .map((c, i) => `${i + 1}. ${c}`)
    .join("\n");

  const verifySection = formatVerifyCommandsForPrompt(verifyCommands);

  const kitchenSection =
    selfHeal && kitchenRoot
      ? `
## Kitchen (issue-dinner self-heal — on by default)

If you discover a bug or missing capability in **issue-dinner itself** while working this course, patch the CLI sources instead of leaving a follow-up.

1. Create \`.issue-dinner/kitchen/inbox/<short-name>/manifest.json\` under the issue-dinner root:
   - **Root:** \`${kitchenRoot}\`
2. Manifest shape:

\`\`\`json
{
  "id": "<short-name>",
  "issueKey": "${issue.key}",
  "reason": "what you fixed in issue-dinner",
  "files": [
    { "path": "src/...", "content": "<full file contents>" }
  ]
}
\`\`\`

3. Only patch \`src/**/*.ts\` paths. issue-dinner applies patches **between courses**, runs typecheck + build, then hot-restarts the serve loop.
4. After serve, run \`issue-dinner kitchen contribute\` to open a PR against \`main\` (or set \`ISSUE_DINNER_CONTRIBUTE_BASE\`).
5. Prefer minimal, focused fixes. Do not patch unrelated files.
`
      : "";

  return `You are implementing one Jira **vertical slice** across a multi-root local workspace when configured.

## Issue
- **Key:** ${issue.key}
- **Summary:** ${issue.summary}
- **Status:** ${issue.status}

## Workspace
${formatWorkspaceSection(roots)}

## Description
${issue.description}

## Verify gate (issue-dinner runs after your handoff)

**Inner loop (blocks the menu):** fast commands — unit tests, typecheck. Run these locally while building.

**Outer loop (CI / manual):** integration/e2e commands — issue-dinner does not block the menu on these when \`serveVerifyGate\` is \`inner\` (default).

Place tests and code so inner verify passes:

${verifySection}
${kitchenSection}
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
- Run the verify commands above plus relevant existing suites in **each** root you touch before finishing.
- Leave all implementation changes **on disk** on the story branch. Do **not** push.
- issue-dinner runs \`git add -A\` and \`git commit\` after your handoff (pre-commit hooks must pass).
- If hooks fail, fix them before finishing — uncommitted WIP blocks the next story in the stack.

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
