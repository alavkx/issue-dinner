import { spawnSync } from "node:child_process";
import { commandExists } from "../util/exec.js";

export interface LaunchOptions {
  session: string;
  /** Shell command run inside tmux (issue-dinner serve …). */
  innerCommand: string;
  attach: boolean;
  detach: boolean;
}

export function ensureTmux(): void {
  if (!commandExists("tmux")) {
    throw new Error(
      "tmux is not on PATH. Install tmux or run `issue-dinner serve` in a persistent terminal.",
    );
  }
}

export function tmuxHasSession(session: string): boolean {
  const r = spawnSync("tmux", ["has-session", "-t", session], {
    encoding: "utf8",
    stdio: "pipe",
  });
  return r.status === 0;
}

export function buildLaunchShellCommand(innerCommand: string): string {
  const apiEnv = "ISSUE_DINNER_CURSOR_API_KEY";
  return [
    `test -n "$${apiEnv}" || { echo "Missing ${apiEnv}" >&2; exit 1; }`,
    innerCommand,
  ].join("; ");
}

export function launchInTmux(opts: LaunchOptions): void {
  ensureTmux();
  const shellCmd = buildLaunchShellCommand(opts.innerCommand);

  if (tmuxHasSession(opts.session)) {
    if (opts.attach) {
      const attach = spawnSync("tmux", ["attach-session", "-t", opts.session], {
        stdio: "inherit",
      });
      if (attach.status !== 0) process.exit(attach.status ?? 1);
      return;
    }
    console.log(`tmux session "${opts.session}" already exists — attach with:`);
    console.log(`  tmux attach -t ${opts.session}`);
    return;
  }

  const args = ["new-session"];
  if (opts.detach) args.push("-d");
  args.push("-s", opts.session, shellCmd);

  const created = spawnSync("tmux", args, { stdio: "inherit" });
  if (created.status !== 0) {
    throw new Error(`tmux failed (exit ${created.status ?? "unknown"})`);
  }

  if (opts.detach) {
    console.log(`Started session "${opts.session}" (detached).`);
    console.log(`  tmux attach -t ${opts.session}`);
    console.log(`  issue-dinner status`);
  }
}
