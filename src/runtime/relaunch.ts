import { spawn } from "node:child_process";
import { resolve } from "node:path";
import * as Effect from "effect/Effect";

/** Child processes spawned by the watchdog carry this env var. */
export const WATCH_CHILD_ENV = "ISSUE_DINNER_WATCH_CHILD";

/** Watchdog interprets this exit code as “rebuild done — respawn child”. */
export const RESTART_EXIT_CODE = 75;

export const isWatchChild = (): boolean =>
  process.env[WATCH_CHILD_ENV] === "1";

/**
 * Restart the current CLI invocation.
 * Under a watchdog parent, exit with {@link RESTART_EXIT_CODE}.
 * Standalone, spawn a detached replacement and exit cleanly.
 */
export const requestRestart = (argv: ReadonlyArray<string>): Effect.Effect<never> =>
  Effect.sync(() => {
    if (isWatchChild()) {
      process.exit(RESTART_EXIT_CODE);
    }

    const script = resolve(process.argv[1] ?? "dist/cli.js");
    const child = spawn(process.execPath, [script, ...argv], {
      detached: true,
      stdio: "inherit",
      env: process.env,
    });
    child.unref();
    process.exit(0);
  });
