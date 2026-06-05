# Heal resume across process restart

Before requesting a post-heal restart, issue-dinner writes `heal-resume.json` under user state with the epic, story index, issue key, serve argv, story agent id, and failure context. After restart, the serve loop reads this checkpoint, clears dangling error fields on the issue record, and resumes the story agent with an explicit “issue-dinner was fixed — continue your slice” message rather than replaying failure context.

We restart the CLI process (not hot-reload) because rebuild loads fresh compiled `dist/`. The SDK has no reliable run-cancel API in our version, so we dispose the story agent before heal and resume it after restart with a clean prompt — avoiding confused agent state from stale errors.
