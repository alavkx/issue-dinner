# issue-dinner

Serve Jira vertical-slice stories through the [Cursor TypeScript SDK](https://cursor.com/docs/sdk/typescript). You **pass the epic (issue group) on the command line**; install config only holds machine paths and verify commands.

Built for [CPD-635](https://istari.atlassian.net/browse/CPD-635) (Platform user event log + Jobs Activity).

## Prerequisites

- Node 20+
- [`acli`](https://developer.atlassian.com/cloud/acli/) — `acli jira auth login --web`
- `ISSUE_DINNER_CURSOR_API_KEY` — [Dashboard → Integrations](https://cursor.com/dashboard/integrations)
- `tmux` — for overnight `launch`
- `gt` (Graphite) — for stack `prep` / per-story checkout
- `poetry` / `npm` in PATH for verify commands

## Install config (once per machine)

Not per epic — only workspace roots, verify commands, and branch namespace:

```bash
mkdir -p ~/.config/issue-dinner
cp config.example.json ~/.config/issue-dinner/config.json
# Edit workspaces, stackAuthor, optional stackBaseOverride
export ISSUE_DINNER_CURSOR_API_KEY="cursor_..."
```

| Field | Purpose |
| ----- | ------- |
| `workspaces` | Repo paths on this machine |
| `stackAuthor` | Branch namespace (`alavoie` → `alavoie/cpd-635/cpd-636`) |
| `stackBaseOverride` | Optional if your epic trunk branch is not `{author}/{epic}-trunk` |
| `issueWorkspace` / `issueWorkspaces` | Optional overrides when heuristics are not enough |

State is per epic: `~/.local/state/issue-dinner/CPD-635/runs.json`.

## Eat an epic

```bash
issue-dinner CPD-635              # same as launch (overnight tmux serve)
issue-dinner CPD-635 launch
issue-dinner CPD-635 list
issue-dinner CPD-635 prep
issue-dinner CPD-635 serve
issue-dinner CPD-635 cook CPD-636
issue-dinner CPD-635 status

# Skip HITL story for this run only
issue-dinner CPD-635 launch --exclude CPD-640
```

Global utilities (no epic):

```bash
issue-dinner show CPD-636
```

## Stack layout (derived from epic)

For `CPD-635` with `stackAuthor: alavoie`:

- Prefix: `alavoie/cpd-635`
- Trunk: `alavoie/cpd-635-trunk` (or `stackBaseOverride`)
- Stories: `alavoie/cpd-635/cpd-636`, …

`prep` / `launch` create branches; each `cook` checks out the story branch. Working trees must be clean.

## Done criteria

A course is **verified** only when handoff is `success`/`partial` **and** verify commands exit 0.

## Tests

```bash
npm test
```
