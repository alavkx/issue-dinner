# Dedicated heal agent with direct source edit

When issue-dinner breaks during a course, a **dedicated heal agent** edits `src/**/*.ts` in the installed package root using normal file tools — not JSON manifest drops. The course agent keeps project workspaces; the heal agent's SDK `cwd` is the issue-dinner package root only.

We chose a dedicated sub-agent (like recovery) over inline course-agent patching because it separates concerns, keeps heal prompts focused, and avoids polluting the course agent transcript with tooling fixes. Typecheck and build failures during the heal loop are feedback signals, not terminal errors — the orchestrator feeds compiler output back until green, then restarts the process and resumes the course.
