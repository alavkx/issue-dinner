# Dedicated heal agent with direct source edit

When issue-dinner breaks during a story, a **dedicated heal agent** edits `src/**/*.ts` in the installed package root using normal file tools — not JSON manifest drops. The story agent keeps project workspaces; the heal agent's SDK `cwd` is the issue-dinner package root only.

We chose a dedicated sub-agent (like recovery) over inline story-agent patching because it separates concerns, keeps heal prompts focused, and avoids polluting the story agent transcript with tooling fixes. Typecheck and build failures during the heal loop are feedback signals, not terminal errors — the orchestrator feeds compiler output back until green, then restarts the process and resumes the story.
