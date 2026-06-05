# Durable heal patches in user state

Healed source files are copied to `~/.local/state/issue-dinner/heals/<patch-id>/` with a manifest (id, issueKey, reason, file contents). On each serve start, durable heals sync into the resolved issue-dinner package root before stories run, so healing survives process restarts and npm reinstalls of the binary package.

We rejected git worktrees and bundled clones in the npm tarball as the primary edit surface — they add setup friction. Publishing `src/` in the npm package plus user-state durability gives npm-install ergonomics without a separate clone to manage. Contribution reads from the applied/durable patch records after heal review approves them.
