import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function runCommand(
  command: string,
  args: string[],
  options?: { cwd?: string; maxBuffer?: number },
): Promise<{ stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      cwd: options?.cwd,
      maxBuffer: options?.maxBuffer ?? 10 * 1024 * 1024,
      env: process.env,
    });
    return { stdout: stdout.toString(), stderr: stderr.toString() };
  } catch (err: unknown) {
    const e = err as NodeJS.ErrnoException & {
      stdout?: Buffer | string;
      stderr?: Buffer | string;
    };
    const error = new Error(e.message) as Error & {
      code?: number;
      stdout?: string;
      stderr?: string;
    };
    error.code =
      typeof e.code === "string" ? 1 : (e.code as number | undefined);
    if (e.stdout != null) error.stdout = String(e.stdout);
    if (e.stderr != null) error.stderr = String(e.stderr);
    throw error;
  }
}

export function commandExists(command: string): boolean {
  try {
    execFileSync("which", [command], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
