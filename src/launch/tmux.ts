import { spawnSync } from "node:child_process";
import type * as CommandExecutor from "@effect/platform/CommandExecutor";
import * as FileSystem from "@effect/platform/FileSystem";
import * as Effect from "effect/Effect";
import { cursorApiKeyEnvName } from "../env.js";
import { TmuxNotFound } from "../effect/errors.js";
import { formatAttachReplay, sessionHistoryPath } from "../serve/transcript.js";
import { commandExists, commandExitCode, shellQuote } from "../util/exec.js";

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

export const ensureTmux = (): Effect.Effect<
  void,
  TmuxNotFound,
  CommandExecutor.CommandExecutor
> =>
  Effect.gen(function* () {
    if (!(yield* commandExists("tmux"))) {
      return yield* Effect.fail(
        new TmuxNotFound({
          message:
            "tmux is not on PATH. Install tmux or run `issue-dinner serve` in a persistent terminal.",
        }),
      );
    }
  });

export const tmuxHasSession = (
  session: string,
): Effect.Effect<boolean, never, CommandExecutor.CommandExecutor> =>
  commandExitCode("tmux", ["has-session", "-t", session]).pipe(
    Effect.map((code) => code === 0),
    Effect.catchAll(() => Effect.succeed(false)),
  );

export function buildLaunchShellCommand(
  innerCommand: string,
  apiKey: string,
  epic?: string,
  replayText?: string,
): string {
  const apiEnv = cursorApiKeyEnvName();
  if (!apiKey.trim()) {
    return [`echo "Missing ${apiEnv}" >&2`, "exit 1"].join("; ");
  }
  const shell = process.env.SHELL?.trim() || "/bin/zsh";
  const historyHint = epic
    ? `echo "Session history: ${sessionHistoryPath(epic)}"`
    : "true";
  const replay =
    epic && replayText
      ? `printf %s ${shellQuote(replayText)}`
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

const attachToSession = (session: string): Effect.Effect<void, never> =>
  Effect.sync(() => {
    const attach = spawnSync("tmux", ["attach-session", "-t", session], {
      stdio: "inherit",
    });
    if (attach.status !== 0) process.exit(attach.status ?? 1);
  });

const createTmuxSession = (
  session: string,
  shellCmd: string,
  detach: boolean,
): Effect.Effect<void, TmuxNotFound> =>
  Effect.gen(function* () {
    const args = ["new-session", "-x", "220", "-y", "60"];
    if (detach) args.push("-d");
    args.push("-s", session, shellCmd);

    const status = yield* Effect.sync(() =>
      spawnSync("tmux", args, { stdio: "inherit" }).status,
    );
    if (status !== 0) {
      return yield* Effect.fail(
        new TmuxNotFound({
          message: `tmux failed (exit ${status ?? "unknown"})`,
        }),
      );
    }
  });

export const launchInTmux = (
  opts: LaunchOptions,
): Effect.Effect<
  void,
  TmuxNotFound | import("@effect/platform/Error").PlatformError,
  CommandExecutor.CommandExecutor | FileSystem.FileSystem
> =>
  Effect.gen(function* () {
    yield* ensureTmux();
    const replayText = opts.epic
      ? yield* formatAttachReplay(opts.epic, 60)
      : undefined;
    const shellCmd = buildLaunchShellCommand(
      opts.innerCommand,
      opts.apiKey,
      opts.epic,
      replayText,
    );
    const detach = opts.detach ?? false;

    if (yield* tmuxHasSession(opts.session)) {
      if (detach) {
        yield* Effect.sync(() => {
          console.log(
            `tmux session "${opts.session}" already exists — attach with:`,
          );
          console.log(`  tmux attach -t ${opts.session}`);
        });
        return;
      }
      yield* attachToSession(opts.session);
      return;
    }

    yield* createTmuxSession(opts.session, shellCmd, detach);

    if (detach) {
      yield* Effect.sync(() => {
        console.log(`Started session "${opts.session}" (detached).`);
        console.log(`  tmux attach -t ${opts.session}`);
        console.log(`  issue-dinner status`);
      });
    }
  });
