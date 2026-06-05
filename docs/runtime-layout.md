# Runtime layout: source, config, and state

issue-dinner is a CLI you run **against your project repos**. The issue-dinner git repository holds **source code only**. Paths, verify commands, run history, and healed snapshots are **runtime data** — they live on your machine, not in git.

## Source (this repository)

Tracked in git:

- `src/**/*.ts` — CLI implementation
- `config.example.json` — shape reference only; copy to install config, do not treat as your machine config
- Tests, docs, vendored `repos/effect/` reference

When you **develop issue-dinner itself**, this tree is also the **self-heal target**: agents may edit `src/` here during dogfood runs. Those edits are normal source changes — commit them like any other code.

## Install config (per machine)

**Not** per epic. Loaded from (first match):

1. `~/.config/issue-dinner/config.json` (recommended)
2. `./issue-dinner.config.json` in the current working directory
3. `./config.example.json` only when developing from a clone without an install config

Contains workspace roots (your backend, frontend, SDK, etc.), `stackAuthor`, verify commands, and optional `sdkClientPackage`.

Never commit real install config. `.gitignore` excludes `config.json` and `issue-dinner.config.json` if they appear in a clone.

## Runtime state (per epic run)

Default location: `~/.local/state/issue-dinner/`

Override: `ISSUE_DINNER_STATE_DIR`

Per epic (`PROJ-100`):

| Path | Purpose |
| ---- | ------- |
| `{state}/PROJ-100/runs.json` | Course status, handoffs, verify results |
| `{state}/PROJ-100/serve-latest.log` | Serve loop log |
| `{state}/PROJ-100/transcripts/{ISSUE}.log` | Per-story agent transcripts |
| `{state}/PROJ-100/session-history.log` | tmux attach replay |
| `{state}/heals/{id}/` | Durable heal manifests + file snapshots |

**Normal use:** state stays under `~/.local/state/`. The issue-dinner repo directory is untouched.

**Dogfooding issue-dinner on itself:** you may set `ISSUE_DINNER_STATE_DIR=.state` (or similar) so run history sits beside the clone. `.state/`, `heals/`, and `transcripts/` are gitignored.

## Self-heal artifacts

Self-heal patches **issue-dinner**, not your project workspaces.

| Artifact | Location | In git? |
| -------- | -------- | ------- |
| Durable heal snapshots | `{state}/heals/` | No — user state |
| Applied heal queue | `{toolRoot}/.issue-dinner/heals/applied/` | No — gitignored |
| Inline / heal-agent edits | `{toolRoot}/src/**/*.ts` | Yes, if you commit them |

`toolRoot` resolves to the installed issue-dinner package (via `ISSUE_DINNER_ROOT`, module location, or `argv[1]`). When your install config lists the issue-dinner clone as a workspace **or** you run from source with self-heal on, `toolRoot` is this repository.

Flow:

1. Course or heal agent edits `src/` under `toolRoot`
2. Validated edits persist to `{state}/heals/`
3. On next serve start, durable heals sync into `toolRoot/src/` and rebuild
4. End-of-serve review may queue contribution under `.issue-dinner/heals/applied/`

Your **project repos** (backend, frontend, etc.) receive agent WIP commits on story branches only — not durable heal manifests.

## What agents should not confuse

- **Config** = where your repos live and how to verify them (`~/.config/issue-dinner/config.json`)
- **State** = what happened during serve runs (progress, logs, durable heals)
- **Source** = issue-dinner `src/` and your project code in configured workspaces

Do not add machine paths, run logs, or heal snapshots to tracked source files. Use install config and state directories instead.
