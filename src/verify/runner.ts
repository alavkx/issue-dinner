import { runCommand } from "../util/exec.js";

export interface VerifyCommand {
  name: string;
  command: string;
  args: string[];
}

export interface VerifyRunResult {
  ok: boolean;
  failures: Array<{ name: string; exitCode: number; output: string }>;
  output: string;
}

export async function runVerifyCommands(
  commands: VerifyCommand[],
  cwd: string,
): Promise<VerifyRunResult> {
  const lines: string[] = [];
  const failures: VerifyRunResult["failures"] = [];

  for (const cmd of commands) {
    lines.push(`$ ${cmd.command} ${cmd.args.join(" ")}`);
    try {
      const { stdout, stderr } = await runCommand(cmd.command, cmd.args, { cwd });
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
