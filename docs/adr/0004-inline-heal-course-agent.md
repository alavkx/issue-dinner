# Inline heal in the course agent

When self-heal is on, the **course agent** has issue-dinner in its workspace and may edit `src/**/*.ts` during a course. After the agent run, the orchestrator diffs issue-dinner `src/` against a baseline snapshot. If files changed, it runs the same **typecheck/build loop** used by the dedicated heal agent — but feeds feedback to the **course agent** (preserving slice context) instead of spawning a heal sub-agent.

On success: persist a **durable heal**, restart, and **heal resume** the blocked course. On decline or exhaustion: escalate to the **dedicated heal agent** (same direct-edit model).

We ship both modes: inline first (cheaper, context-preserving), dedicated as fallback when the course agent did not fix the tool or inline validation failed.
