# issue-dinner

Serve Jira vertical-slice stories through the [Cursor TypeScript SDK](https://cursor.com/docs/sdk/typescript). You **pass the epic (issue group) on the command line**; install config only holds machine paths and verify commands.

Built for [CPD-635](https://istari.atlassian.net/browse/CPD-635) (Platform user event log + Jobs Activity).

## Prerequisites

- Node 20+
- [`acli`](https://developer.atlassian.com/cloud/acli/) — `acli jira auth login --web`
- `ISSUE_DINNER_CURSOR_API_KEY` — [Dashboard → Integrations](https://cursor.com/dashboard/integrations)
- `cursor` CLI — **local** SDK agents (not cloud)
- `tmux` — for `launch` (session stays open as the dinner UI)
- `gt` (Graphite) — for stack `prep` / per-story checkout
- `poetry` / `npm` in PATH for verify commands

## Install config (once per machine)

Not per epic — only workspace roots, verify commands, and branch namespace:

```bash
mkdir -p ~/.config/issue-dinner
cp config.example.json ~/.config/issue-dinner/config.json
# Edit workspaces, stackAuthor, optional stackBaseOverride, verifyCommands
export ISSUE_DINNER_CURSOR_API_KEY="cursor_..."
```

| Field | Purpose |
| ----- | ------- |
| `workspaces` | Repo paths on this machine |
| `stackAuthor` | Branch namespace (`alavoie` → `alavoie/cpd-635/cpd-636`) |
| `stackBaseOverride` | Optional if your epic trunk branch is not `{author}/{epic}-trunk` |
| `verifyCommands` / `issueVerifyCommands` | Shell verify gates (paths must exist — preflight checks) |
| `commitWip` | Commit agent WIP on story branches after each course (default `true`) |
| `blockerPolicy` | `strict` (only `verified` unblocks) or `agent_complete` |
| `quietRecovery` | Recovery agents log to transcript only (default `true`) |

State is per epic: `~/.local/state/issue-dinner/CPD-635/runs.json`  
Serve log: `~/.local/state/issue-dinner/CPD-635/serve-latest.log`

## Eat an epic

Recommended flow:

```bash
issue-dinner CPD-635 cook CPD-636          # prove one course first
issue-dinner CPD-635 launch --exclude CPD-640   # preflight + prep + tmux serve
```

Commands:

```bash
issue-dinner CPD-635              # same as launch (preflight + prep + attached tmux)
issue-dinner CPD-635 list
issue-dinner CPD-635 status --verbose
issue-dinner CPD-635 prep --dry-run
issue-dinner CPD-635 serve --exclude CPD-640
issue-dinner CPD-635 cook CPD-636 --force
issue-dinner verify CPD-636
```

`launch` and `serve` run **preflight** first (API key, acli, cursor CLI, inner verify paths). Dirty trees are auto-committed when possible, otherwise warned (not blocked). Verified and in-progress courses skip path checks. Use `--skip-preflight` only when you know the runway is good.

`serve` skips **verified** courses by default (`--no-skip-done` to re-run them).

**Menu order:** each course requires prior courses in the epic menu to be **verified** (not merely `agent_complete`). `--continue-on-error` does not skip this — it only avoids stopping the loop on the first verify failure; dirty repos always halt the menu.

On failure, dinner prints a **DINNER HALTED** block after the summary with the blocking course and reason.

Use `--detach` on launch to background tmux. Default attaches you to the session; when serve finishes the shell stays open.

## Stack layout (derived from epic)

For `CPD-635` with `stackAuthor: alavoie`:

- Prefix: `alavoie/cpd-635`
- Trunk: `alavoie/cpd-635-trunk` (or `stackBaseOverride`)
- Stories: `alavoie/cpd-635/cpd-636`, …

`prep` / `launch` create branches; each course checks out its story branch, runs a **local** agent, commits WIP, then runs verify.

## Done criteria

A course is **verified** only when handoff is `success`/`partial` **and** verify commands exit 0. Agent-only success is **`agent_complete`** (verify failed).

## Tests

```bash
npm test
```
