import type { ServeVerifyGate } from "../config.js";
import { runCommand } from "../util/exec.js";
import { fg } from "../ui/theme.js";
import type { ResolvedVerifyCommand } from "./resolve.js";
import { effectiveVerifyTier } from "./tier.js";

export interface VerifyCommand {
  name: string;
  command: string;
  args: string[];
  workspace?: string;
  tier?: "inner" | "outer";
}

/** Commands that run during serve, based on serveVerifyGate. */
export function filterVerifyCommandsForServe(
  commands: ResolvedVerifyCommand[],
  gate: ServeVerifyGate,
): ResolvedVerifyCommand[] {
  if (gate === "none") return [];
  if (gate === "full") return commands;
  return commands.filter((cmd) => effectiveVerifyTier(cmd) === "inner");
}

export interface VerifyRunResult {
  ok: boolean;
  failures: Array<{ name: string; exitCode: number; output: string }>;
  output: string;
}

export async function runVerifyCommands(
  commands: ResolvedVerifyCommand[],
): Promise<VerifyRunResult> {
  const lines: string[] = [];
  const failures: VerifyRunResult["failures"] = [];

  for (const cmd of commands) {
    lines.push(
      fg.cyan(`[${cmd.cwd}]`) +
        ` ${fg.bold("$")} ${cmd.command} ${cmd.args.join(" ")}`,
    );
    try {
      const { stdout, stderr } = await runCommand(cmd.command, cmd.args, {
        cwd: cmd.cwd,
      });
      if (stdout) lines.push(stdout);
      if (stderr) lines.push(stderr);
    } catch (err: unknown) {
      const e = err as { code?: number; stdout?: string; stderr?: string };
      const output = [e.stdout, e.stderr].filter(Boolean).join("\n");
      lines.push(output);
      failures.push({
        name: cmd.name,
        exitCode: typeof e.code === "number" ? e.code : 1,
        output,
      });
    }
  }

  return { ok: failures.length === 0, failures, output: lines.join("\n") };
}
