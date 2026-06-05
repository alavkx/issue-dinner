# issue-dinner

Serve Jira vertical-slice stories through the [Cursor TypeScript SDK](https://cursor.com/docs/sdk/typescript). You **pass the epic (issue group) on the command line**; install config only holds machine paths and verify commands.

See [docs/runtime-layout.md](docs/runtime-layout.md) for how **source**, **install config**, and **runtime state** are separated — including self-heal when dogfooding issue-dinner on itself.

## Prerequisites

- Node 20+
- [`acli`](https://developer.atlassian.com/cloud/acli/) — `acli jira auth login --web`
- `ISSUE_DINNER_CURSOR_API_KEY` — [Dashboard → Integrations](https://cursor.com/dashboard/integrations)
- `cursor` CLI — **local** SDK agents (not cloud)
- `tmux` — for `launch` (session stays open as the dinner UI)
- `gt` (Graphite) — for stack `prep` / per-story checkout
- `poetry` / `npm` in PATH for verify commands

## Install config (once per machine)

Not per epic — only workspace roots, verify commands, and branch namespace. Lives **outside** this repo:

```bash
mkdir -p ~/.config/issue-dinner
cp config.example.json ~/.config/issue-dinner/config.json
# Edit workspaces, stackAuthor, optional stackBaseOverride, verifyCommands
export ISSUE_DINNER_CURSOR_API_KEY="cursor_..."
```

| Field | Purpose |
| ----- | ------- |
| `workspaces` | Your project repo paths on this machine |
| `stackAuthor` | Branch namespace (`you` → `you/proj-100/proj-101`) |
| `stackBaseOverride` | Optional if your epic trunk branch is not `{author}/{epic}-trunk` |
| `sdkClientPackage` | npm package in frontend to link to local `sdk` workspace |
| `verifyCommands` / `issueVerifyCommands` | Shell verify gates (paths must exist — preflight checks) |
| `commitWip` | Commit agent WIP on story branches after each story (default `true`) |
| `blockerPolicy` | `strict` (only `verified` unblocks) or `agent_complete` |
| `quietRecovery` | Recovery agents log to transcript only (default `true`) |

Runtime state (not in git): `~/.local/state/issue-dinner/PROJ-100/runs.json`, serve logs, transcripts, durable heals.

## Eat an epic

Recommended flow:

```bash
issue-dinner PROJ-100 run PROJ-101          # prove one story first
issue-dinner PROJ-100 launch --exclude PROJ-105   # preflight + prep + tmux serve
```

Commands:

```bash
issue-dinner PROJ-100              # same as launch (preflight + prep + attached tmux)
issue-dinner PROJ-100 list
issue-dinner PROJ-100 status --verbose
issue-dinner PROJ-100 prep --dry-run
issue-dinner PROJ-100 serve --exclude PROJ-105
issue-dinner PROJ-100 run PROJ-101 --force
issue-dinner verify PROJ-101
```

`launch` and `serve` run **preflight** first (API key, acli, cursor CLI, inner verify paths). Dirty trees are auto-committed when possible, otherwise warned (not blocked). Verified and in-progress stories skip path checks. Use `--skip-preflight` only when you know the runway is good.

`serve` skips **verified** stories by default (`--no-skip-done` to re-run them).

**Story order:** each story requires prior stories in the epic to be **verified** (not merely `agent_complete`). `--continue-on-error` does not skip this — it only avoids stopping the loop on the first verify failure; dirty repos always halt the run.

On failure, issue-dinner prints a **RUN HALTED** block after the summary with the blocking story and reason.

Use `--detach` on launch to background tmux. Default attaches you to the session; when serve finishes the shell stays open.

## Stack layout (derived from epic)

For `PROJ-100` with `stackAuthor: you`:

- Prefix: `you/proj-100`
- Trunk: `you/proj-100-trunk` (or `stackBaseOverride`)
- Stories: `you/proj-100/proj-101`, …

`prep` / `launch` create branches in **your project workspaces**; each story checks out its branch, runs a **local** agent, commits WIP, then runs verify.

## Done criteria

A story is **verified** only when handoff is `success`/`partial` **and** verify commands exit 0. Agent-only success is **`agent_complete`** (verify failed).

## Tests

```bash
npm test
```
