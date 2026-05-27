import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function runCommand(
  command: string,
  args: string[],
  options?: { cwd?: string; maxBuffer?: number },
): Promise<{ stdout: string; stderr: string }> {
  const { stdout, stderr } = await execFileAsync(command, args, {
    cwd: options?.cwd,
    maxBuffer: options?.maxBuffer ?? 10 * 1024 * 1024,
    env: process.env,
  });
  return { stdout: stdout.toString(), stderr: stderr.toString() };
}

export function commandExists(command: string): boolean {
  try {
    execFileSync("which", [command], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
