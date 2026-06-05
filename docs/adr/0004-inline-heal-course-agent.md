# Inline heal in the story agent

When self-heal is on, the **story agent** has issue-dinner in its workspace and may edit `src/**/*.ts` during a story. After the agent run, the orchestrator diffs issue-dinner `src/` against a baseline snapshot. If files changed, it runs the same **typecheck/build loop** used by the dedicated heal agent — but feeds feedback to the **story agent** (preserving slice context) instead of spawning a heal sub-agent.

On success: persist a **durable heal**, restart, and **heal resume** the blocked story. On decline or exhaustion: escalate to the **dedicated heal agent** (same direct-edit model).

We ship both modes: inline first (cheaper, context-preserving), dedicated as fallback when the story agent did not fix the tool or inline validation failed.
