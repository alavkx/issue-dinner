# issue-dinner roadmap

## Branch stacks (Graphite)

**Shipped (v1).**

- `issue-dinner <epic> prep` — create/sync story branches (stack derived from epic + `stackAuthor`)
- `issue-dinner <epic> launch` — runs `prep` by default (`--no-prep` to skip)
- Each `cook` / `serve` course checks out `{prefix}/{issue-key}` in participating workspaces before the agent runs
- Branches are stacked with `gt branch create`; no commits from prep

Future: Graphite submit integration, dirty-tree auto-stash, parallel workspace prep.

## Other gaps

- Second-agent verifier (shell verify only today)
- Parallel `serve` waves (workspace mutex)
- Auto-retry on failure
- Cloud `repos[]` for isolated clones/PRs
