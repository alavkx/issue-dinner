# issue-dinner roadmap

## Branch stacks (Graphite)

**Shipped (v1).**

- `issue-dinner <epic> prep` — create/sync story branches (stack derived from epic + `stackAuthor`)
- `issue-dinner <epic> launch` — preflight → prep → tmux serve (attached by default)
- Each `cook` / `serve` course checks out `{prefix}/{issue-key}` in participating workspaces before the agent runs
- Branches are stacked with `gt branch create`; auto-tracks existing `stackBaseOverride` bases
- WIP committed on story branches after each successful agent phase (`commitWip`, default on)

## Observability & preflight (shipped)

- Preflight runs at start of `launch` / `serve` (fix hints inline; `--skip-preflight` to bypass)
- Verify path validation before agents run
- Serve log: `~/.local/state/issue-dinner/{EPIC}/serve-latest.log`
- Exit summary with branches/commits per story; tmux keeps shell open after serve

## Other gaps

- Second-agent verifier (shell verify only today)
- Parallel `serve` waves (workspace mutex)
- Auto-retry on failure
- Graphite submit integration
- Cloud `repos[]` for isolated clones/PRs
- Dirty-tree auto-stash
