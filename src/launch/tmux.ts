import { spawnSync } from "node:child_process";
import { cursorApiKeyEnvName } from "../env.js";
import { formatAttachReplay } from "../serve/transcript.js";
import { sessionHistoryPath } from "../serve/transcript.js";
import { commandExists, shellQuote } from "../util/exec.js";

export interface LaunchOptions {
  session: string;
  /** Shell command run inside tmux (issue-dinner serve …). */
  innerCommand: string;
  /** Cursor API key — embedded in the tmux shell (tmux often drops inherited env). */
  apiKey: string;
  /** Epic key for session-history replay on attach (e.g. CPD-635). */
  epic?: string;
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
  epic?: string,
): string {
  const apiEnv = cursorApiKeyEnvName();
  if (!apiKey.trim()) {
    return [`echo "Missing ${apiEnv}" >&2`, "exit 1"].join("; ");
  }
  const shell = process.env.SHELL?.trim() || "/bin/zsh";
  const historyHint = epic
    ? `echo "Session history: ${sessionHistoryPath(epic)}"`
    : "true";
  const replay = epic
    ? `printf %s ${shellQuote(formatAttachReplay(epic, 60))}`
    : "true";
  return [
    `export ${apiEnv}=${shellQuote(apiKey.trim())}`,
    historyHint,
    replay,
    innerCommand,
    "ec=$?",
    'echo ""',
    'echo "══════════════════════════════════════════════════════════"',
    'echo "serve finished (exit $ec) — shell stays open (Ctrl-d to close)"',
    'echo "  Re-run: issue-dinner EPIC serve --exclude …"',
    'echo "  Logs: tail -f ~/.local/state/issue-dinner/EPIC/serve-latest.log"',
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
  const shellCmd = buildLaunchShellCommand(
    opts.innerCommand,
    opts.apiKey,
    opts.epic,
  );
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

  const args = ["new-session", "-x", "220", "-y", "60"];
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
