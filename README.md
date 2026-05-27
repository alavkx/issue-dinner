# issue-dinner

Serve Jira vertical-slice stories through the [Cursor TypeScript SDK](https://cursor.com/docs/sdk/typescript). Fetches issue bodies via `acli`, builds an implementation prompt, and runs a **local** agent against the configured workspace.

Built for the **Platform user event log + Jobs Activity** epic ([CPD-635](https://istari.atlassian.net/browse/CPD-635)) but works for any parent/child Jira setup.

## Prerequisites

- Node 20+
- [`acli`](https://developer.atlassian.com/cloud/acli/) authenticated: `acli jira auth login --web`
- `CURSOR_API_KEY` from [Cursor Dashboard → Integrations](https://cursor.com/dashboard/integrations)

## Setup

```bash
cd ~/code/issue-dinner
npm install
cp config.example.json issue-dinner.config.json
# Edit workspace paths in issue-dinner.config.json
export CURSOR_API_KEY="cursor_..."
```

## Commands

| Command | Description |
|---------|-------------|
| `npm run dev -- list` | List epic children + local run status |
| `npm run dev -- show CPD-636` | Print issue description + parsed sections |
| `npm run dev -- status` | Processing state from `.state/runs.json` |
| `npm run dev -- cook CPD-636` | Run agent for one issue |
| `npm run dev -- cook CPD-636 --dry-run` | Print prompt only |
| `npm run dev -- serve` | Process epic in dependency order |
| `npm run dev -- serve --skip-done` | Resume menu, skip finished courses |

After `npm run build`, use `npm start -- <command>` or `npx issue-dinner <command>`.

## Config

`issue-dinner.config.json` (gitignored) or `~/.config/issue-dinner/config.json`:

- `epic` — default epic key (`CPD-635`)
- `workspaces` — named repo roots (`backend`, `frontend`, `sdk`, `schemas`)
- `issueWorkspace` — optional per-key override
- `model` — Cursor model id (default `composer-2.5`)

Workspace selection uses `issueWorkspace` first, then heuristics on the description (frontend vs backend vs OpenAPI).

## State

`.state/runs.json` tracks per-issue status (`pending` / `running` / `finished` / `error`), agent/run ids, and blocker gating for `serve`. Blockers are parsed from the **Blocked by** section (e.g. `CPD-636`).

## Epic menu (CPD-635)

| Key | Summary |
|-----|---------|
| CPD-636 | Replayable `GET /events` + wire contract |
| CPD-637 | Job status → user event log |
| CPD-638 | Notifications delivery coexistence |
| CPD-639 | Client event poll + `applyEntityPatch` |
| CPD-640 | OpenAPI `EventData` union (HITL) |
| CPD-641 | Jobs Activity end-to-end |

Suggested order: `serve` (respects blockers) or `cook` per key.

## Notes

- Agents run **locally** with `settingSources: []` (no ambient Cursor rules unless you change that).
- Does **not** commit or push; prompts tell the agent the same.
- Slice **CPD-640** is HITL — review before `cook`.
