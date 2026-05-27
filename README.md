# issue-dinner

Serve Jira vertical-slice stories through the [Cursor TypeScript SDK](https://cursor.com/docs/sdk/typescript). Fetches issue bodies via `acli`, runs a **local** agent with **TDD + structured handoff** prompts, then runs **verify commands** before marking a course `verified`.

Built for [CPD-635](https://istari.atlassian.net/browse/CPD-635) (Platform user event log + Jobs Activity).

## Prerequisites

- Node 20+
- [`acli`](https://developer.atlassian.com/cloud/acli/) — `acli jira auth login --web`
- `CURSOR_API_KEY` — [Dashboard → Integrations](https://cursor.com/dashboard/integrations)
- `poetry` / `npm` in PATH for verify commands (per repo)

## Setup

```bash
cd ~/code/issue-dinner
npm install
cp config.example.json issue-dinner.config.json
# Edit workspace paths and verifyCommands
export CURSOR_API_KEY="cursor_..."
```

## Overnight run (recommended)

```bash
tmux new -s dinner
cd ~/code/issue-dinner
export CURSOR_API_KEY="..."

npm run dev -- serve --continue-on-error --skip-done
# Excludes CPD-640 by default (HITL). Ctrl-b d to detach.
```

Morning: `npm run dev -- status` then review `git status` in each repo.

## Commands

| Command        | Description                               |
| -------------- | ----------------------------------------- |
| `list [epic]`  | Epic children + local status              |
| `show <key>`   | Issue body + parsed sections              |
| `status`       | `.state/runs.json` (use `--epic CPD-635`) |
| `cook <key>`   | Agent → handoff check → verify            |
| `verify <key>` | Re-run verify only                        |
| `serve [epic]` | Full menu in dependency order             |

### Serve flags

| Flag                  | Purpose                                   |
| --------------------- | ----------------------------------------- |
| `--continue-on-error` | Keep going after a failed course          |
| `--skip-done`         | Skip issues already `verified`            |
| `--exclude KEYS`      | Extra keys to skip (config has `CPD-640`) |
| `--only KEYS`         | Subset of the menu                        |
| `--force`             | Ignore blocker state                      |

## Done criteria

A course is **verified** (counts for blockers) only when:

1. Cursor run completes with handoff `Status: success` or `partial`
2. Configured **verify commands** exit 0 for that issue/workspace

`agent_complete` without verify does **not** unblock dependents.

## Config highlights

| Field                 | Default       | Meaning                          |
| --------------------- | ------------- | -------------------------------- |
| `settingSources`      | `["project"]` | Load repo `AGENTS.md` / rules    |
| `requireVerify`       | `true`        | Run `verifyCommands` after agent |
| `exclude`             | `["CPD-640"]` | HITL slice skipped in `serve`    |
| `verifyCommands`      | per workspace | Hard gate (pytest, vitest, …)    |
| `issueVerifyCommands` | optional      | Override per Jira key            |
| `issueWorkspaces`     | optional      | Multi-root SDK `cwd` per issue   |

### Multi-root workspaces

Cursor SDK accepts `local.cwd` as `string | string[]`. For slices that touch several repos (e.g. CPD-636):

```json
"issueWorkspaces": {
  "CPD-636": ["backend", "schemas", "sdk", "frontend"]
}
```

One agent run can edit all roots. Verify runs `verifyCommands` for each root (or use `issueVerifyCommands` with a `workspace` field per command). Single-root issues still use `issueWorkspace` or heuristics.

## Agent prompt

Each `cook` uses:

- **Vertical-slice TDD** (one test → one implementation, public interfaces)
- **Orchestrate-style handoff** (`Status`, `Verification`, `Measurements`, …)

Inspired by Cursor's `/orchestrate` worker + verifier split; issue-dinner implements the verifier as shell commands, not a second agent (v1).

## Tests

```bash
npm test
```

## Epic menu

| Key     | Workspace | Notes                                         |
| ------- | --------- | --------------------------------------------- |
| CPD-636 | backend   | OpenAPI/SDK may need follow-up or extra cooks |
| CPD-637 | backend   |                                               |
| CPD-638 | backend   | Custom verify in example config               |
| CPD-639 | frontend  | Blocked by 636                                |
| CPD-640 | —         | **Excluded** (HITL)                           |
| CPD-641 | frontend  | Blocked by 637, 639                           |
