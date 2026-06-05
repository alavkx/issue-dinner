import type { ResolvedVerifyCommand } from "./resolve.js";

export function formatVerifyCommandsForPrompt(
  commands: ResolvedVerifyCommand[],
): string {
  if (commands.length === 0) {
    return "(no automated tests wired for this story — agent should still run tests from the ticket and handoff)";
  }
  return commands
    .map(
      (cmd) =>
        `- \`${cmd.cwd}\`: \`${cmd.command} ${cmd.args.join(" ")}\` (${cmd.name})`,
    )
    .join("\n");
}
