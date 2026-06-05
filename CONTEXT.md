# Issue Dinner

Orchestrates Jira vertical-slice work with Cursor agents: stack prep, story-by-story serve loops, verify gates, and recovery when workspaces or agents fail.

## Runtime boundaries

- **Install config** — machine paths and verify commands (`~/.config/issue-dinner/config.json`). Not in the issue-dinner repo.
- **Runtime state** — per-epic runs, logs, transcripts, durable heals (`~/.local/state/issue-dinner/` by default). Not in the issue-dinner repo unless dogfooding with a local `ISSUE_DINNER_STATE_DIR`.
- **Source** — issue-dinner `src/` and the user's project repos listed in install config workspaces.

Self-heal is the exception that touches issue-dinner source: heal agents edit `src/` in the package root; durable heals live in state and sync back on serve start. See `docs/runtime-layout.md`.

## Language

### Serve & stories

**Epic**: A Jira epic whose child stories form the work queue for one dinner run.

**Story**: One issue processed during a serve loop — checkout, agent work, verify, advance.

**Serve loop**: The long-running process that walks the epic story by story.

### Self-heal

**Self-heal**: The subsystem that patches **issue-dinner itself** (not project repos) so a blocked story can continue.

**Heal agent**: A dedicated Cursor sub-agent whose only job is to edit issue-dinner `src/**/*.ts` when the tool is broken. Distinct from the **story agent** (implements the Jira slice) and the **recovery agent** (fixes workspace/git state).

**Heal loop**: Iterative typecheck/build feedback while the heal agent edits sources. Typecheck errors are normal signals to keep iterating — not terminal failures.

**Durable heal**: A persisted copy of healed source files under the user state directory (`~/.local/state/issue-dinner/heals/`). Survives process restarts and npm reinstalls of the package; synced back into the installed package on serve start.

**Heal resume**: Checkpoint written before a heal restart so the serve loop can re-enter the same story and resume the story agent with a clean “issue-dinner was fixed” message (no dangling error state).

**Heal review**: End-of-serve sub-agent that judges whether durable heals are worth upstream PRs — analogous to verify for story work.

**Contribution**: Opening a PR against issue-dinner `main` for heals the review agent approves.

_Avoid_: “patch manifest inbox” as a manual agent interface (removed; heal agent edits source directly).

### Agents

**Story agent**: Implements the Jira vertical slice in configured project workspaces.

**Recovery agent**: Fixes git/workspace/stack state so the story agent can continue project work.

**Heal agent**: Fixes issue-dinner source so orchestration can continue.

**Inline heal**: The story agent edits issue-dinner `src/` during a story; the orchestrator detects those edits, validates via typecheck/build with the same agent, persists a **durable heal**, and restarts. Escalates to the **Heal agent** when inline validation fails.

## Relationships

- A **Serve loop** processes many **Stories** from one **Epic**.
- A **Story** is driven by a **Story agent** in project workspace(s).
- When issue-dinner itself is broken, a **Heal agent** runs in the issue-dinner package root (direct `src/` edits), or the **Story agent** may **Inline heal** first.
- A successful **Heal loop** produces a **Durable heal** and triggers **Heal resume** after restart.
- At serve end, **Heal review** gates **Contribution** for approved **Durable heals**.

## Example dialogue

> **Dev:** "The story agent crashed because verify resolution threw in issue-dinner — do we run recovery or heal?"
>
> **Domain expert:** "Recovery first if it's dirty git on the story branch. If recovery is exhausted or the stack trace is in issue-dinner `src/`, run the **Heal agent**. It edits issue-dinner source directly; typecheck errors are just the next loop iteration. When typecheck and build pass, we restart and **Heal resume** picks up the same **Story** with a clean message to the **Story agent**."

> **Dev:** "Where do healed files live after npm install -g?"
>
> **Domain expert:** "**Durable heal** in user state. On serve start we sync into the installed package `src/`, rebuild, then run. At end of serve, **Heal review** decides what gets **Contribution**."

## Flagged ambiguities

- "Kitchen" — retired metaphor for manifest inbox drops between stories; use **Heal agent** direct edit and `heal status` / `heal contribute` CLI.
- "Course" / "cook" — retired CLI and domain terms; use **story** and `run` for a single issue.
- "Self-heal" vs "heal" — resolved: **Self-heal** is the feature flag; **Heal agent** / **Heal loop** are the active mechanisms.
