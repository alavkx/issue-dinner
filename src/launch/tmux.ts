import { spawnSync } from "node:child_process";
import { cursorApiKeyEnvName } from "../env.js";
import { commandExists, shellQuote } from "../util/exec.js";

export interface LaunchOptions {
  session: string;
  /** Shell command run inside tmux (issue-dinner serve …). */
  innerCommand: string;
  /** Cursor API key — embedded in the tmux shell (tmux often drops inherited env). */
  apiKey: string;
  /** Run tmux detached instead of attaching the caller (default: attach). */
  detach?: boolean;
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

export function buildLaunchShellCommand(
  innerCommand: string,
  apiKey: string,
): string {
  const apiEnv = cursorApiKeyEnvName();
  if (!apiKey.trim()) {
    return [`echo "Missing ${apiEnv}" >&2`, "exit 1"].join("; ");
  }
  const shell = process.env.SHELL?.trim() || "/bin/zsh";
  return [
    `export ${apiEnv}=${shellQuote(apiKey.trim())}`,
    innerCommand,
    "ec=$?",
    'echo ""',
    'echo "══════════════════════════════════════════════════════════"',
    'echo "serve finished (exit $ec) — shell stays open (Ctrl-d to close)"',
    'echo "  issue-dinner status"',
    'echo "══════════════════════════════════════════════════════════"',
    `exec ${shellQuote(shell)} -l`,
  ].join("; ");
}

function attachToSession(session: string): void {
  const attach = spawnSync("tmux", ["attach-session", "-t", session], {
    stdio: "inherit",
  });
  if (attach.status !== 0) process.exit(attach.status ?? 1);
}

export function launchInTmux(opts: LaunchOptions): void {
  ensureTmux();
  const shellCmd = buildLaunchShellCommand(opts.innerCommand, opts.apiKey);
  const detach = opts.detach ?? false;

  if (tmuxHasSession(opts.session)) {
    if (detach) {
      console.log(`tmux session "${opts.session}" already exists — attach with:`);
      console.log(`  tmux attach -t ${opts.session}`);
      return;
    }
    attachToSession(opts.session);
    return;
  }

  const args = ["new-session"];
  if (detach) args.push("-d");
  args.push("-s", opts.session, shellCmd);

  const created = spawnSync("tmux", args, { stdio: "inherit" });
  if (created.status !== 0) {
    throw new Error(`tmux failed (exit ${created.status ?? "unknown"})`);
  }

  if (detach) {
    console.log(`Started session "${opts.session}" (detached).`);
    console.log(`  tmux attach -t ${opts.session}`);
    console.log(`  issue-dinner status`);
  }
}
