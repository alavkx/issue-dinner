import type { ResolvedVerifyCommand } from "./resolve.js";

export function formatVerifyCommandsForPrompt(
  commands: ResolvedVerifyCommand[],
): string {
  if (commands.length === 0) {
    return "(no verify commands configured — ask the operator to add issueVerifyCommands in install config)";
  }
  return commands
    .map(
      (cmd) =>
        `- \`${cmd.cwd}\`: \`${cmd.command} ${cmd.args.join(" ")}\` (${cmd.name})`,
    )
    .join("\n");
}
