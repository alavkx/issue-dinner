import { join, resolve } from "node:path";
import * as Command from "@effect/platform/Command";
import type * as CommandExecutor from "@effect/platform/CommandExecutor";
import * as FileSystem from "@effect/platform/FileSystem";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as out from "../ui/out.js";
import { projectSrcDir, resolveProjectRoot } from "./project-root.js";
import { isStayAwakeEnabled, startStayAwake } from "./stay-awake.js";
import {
  isWatchChild,
  RESTART_EXIT_CODE,
  WATCH_CHILD_ENV,
} from "./relaunch.js";

export const WATCH_FLAG = "--watch";
export const WATCH_RESTART_ON_CRASH_FLAG = "--watch-restart-on-crash";
export const NO_WATCH_RESTART_ON_CRASH_FLAG = "--no-watch-restart-on-crash";

const CRASH_BACKOFF = Duration.seconds(2);
const WATCH_DEBOUNCE = Duration.millis(500);

const SOURCE_FILE_RE = /\.tsx?$/;

export interface WatchdogOptions {
  readonly restartOnCrash: boolean;
}

export interface StrippedWatchArgv {
  readonly argv: ReadonlyArray<string>;
  readonly watch: boolean;
  readonly restartOnCrash: boolean;
}

export function stripWatchArgv(argv: ReadonlyArray<string>): StrippedWatchArgv {
  const watch = argv.includes(WATCH_FLAG);
  const restartOnCrash =
    !argv.includes(NO_WATCH_RESTART_ON_CRASH_FLAG) &&
    (argv.includes(WATCH_RESTART_ON_CRASH_FLAG) || watch);
  const filtered = argv.filter(
    (arg) =>
      arg !== WATCH_FLAG &&
      arg !== WATCH_RESTART_ON_CRASH_FLAG &&
      arg !== NO_WATCH_RESTART_ON_CRASH_FLAG,
  );
  return { argv: filtered, watch, restartOnCrash };
}

const isSourceWatchEvent = (
  event: FileSystem.WatchEvent,
  srcRoot: string,
): boolean => {
  const path = "path" in event ? event.path : undefined;
  if (!path) return false;
  const rel = path.startsWith(srcRoot)
    ? path.slice(srcRoot.length + 1)
    : path;
  return SOURCE_FILE_RE.test(rel);
};

const rebuildProject = (
  root: string,
): Effect.Effect<
  void,
  import("../effect/errors.js").CommandFailed | import("@effect/platform/Error").PlatformError,
  CommandExecutor.CommandExecutor
> =>
  Effect.gen(function* () {
    out.phase("watchdog", "rebuilding issue-dinner");
    yield* Effect.scoped(
      Effect.gen(function* () {
        const cmd = Command.workingDirectory(
          Command.make("npm", "run", "build"),
          root,
        );
        const process = yield* Command.start(cmd);
        const exitCode = yield* process.exitCode;
        if (exitCode !== 0) {
          out.warn(`watchdog: build exited ${exitCode} — continuing with previous dist`);
        } else {
          out.success("watchdog: rebuild complete");
        }
      }),
    );
  });

const spawnSupervisedChild = (
  argv: ReadonlyArray<string>,
  reloadSignal: Queue.Queue<void>,
): Effect.Effect<
  { exitCode: number; reloaded: boolean },
  import("@effect/platform/Error").PlatformError,
  CommandExecutor.CommandExecutor
> =>
  Effect.scoped(
    Effect.gen(function* () {
      const entry = resolve(process.argv[1] ?? "dist/cli.js");
      let cmd = Command.make(process.execPath, entry, ...argv);
      cmd = Command.env(cmd, { [WATCH_CHILD_ENV]: "1" });
      const child = yield* Command.start(cmd);
      const reloadedRef = yield* Effect.sync(() => ({ value: false }));

      const exitFiber = yield* child.exitCode.pipe(Effect.fork);
      const reloadFiber = yield* Queue.take(reloadSignal).pipe(
        Effect.flatMap(() =>
          Effect.gen(function* () {
            out.phase("watchdog", "source changed — restarting child");
            reloadedRef.value = true;
            yield* child.kill("SIGTERM");
          }),
        ),
        Effect.forever,
        Effect.fork,
      );

      const exitCode = yield* Fiber.join(exitFiber);
      yield* Fiber.interrupt(reloadFiber);
      while ((yield* Queue.size(reloadSignal)) > 0) {
        yield* Queue.take(reloadSignal);
      }
      return { exitCode, reloaded: reloadedRef.value };
    }),
  );

const shouldStopSupervisor = (exitCode: number): boolean =>
  exitCode === 0 || exitCode === 2 || exitCode === 130;

const isCrashExit = (exitCode: number): boolean =>
  !shouldStopSupervisor(exitCode) && exitCode !== RESTART_EXIT_CODE;

/**
 * Nodemon-style supervisor: watch `src/`, rebuild on change, respawn the CLI child.
 * Uses `@effect/platform` FileSystem.watch and Command.
 */
export const runWatchdog = (
  argv: ReadonlyArray<string>,
  options: WatchdogOptions,
): Effect.Effect<
  void,
  unknown,
  FileSystem.FileSystem | CommandExecutor.CommandExecutor
> =>
  Effect.gen(function* () {
    if (isWatchChild()) {
      return yield* Effect.die(
        new Error("watchdog cannot nest — remove --watch from child argv"),
      );
    }

    const root = yield* resolveProjectRoot();
    const srcRoot = projectSrcDir(root);
    const fs = yield* FileSystem.FileSystem;
    const reloadSignal = yield* Queue.unbounded<void>();

    out.banner("Issue dinner watchdog");
    out.info(`Watching ${srcRoot}`);
    out.info(`Child: ${process.execPath} ${process.argv[1]} ${argv.join(" ")}`);

    if (isStayAwakeEnabled(argv)) {
      yield* startStayAwake();
    }

    yield* fs.watch(srcRoot, { recursive: true }).pipe(
      Stream.filter((event) => isSourceWatchEvent(event, srcRoot)),
      Stream.debounce(WATCH_DEBOUNCE),
      Stream.runForEach(() => Queue.offer(reloadSignal, void 0)),
      Effect.forkDaemon,
    );

    let pass = 0;
    while (true) {
      pass += 1;
      if (pass > 1) {
        yield* rebuildProject(root);
      }

      out.phase("watchdog", `starting child (pass ${pass})`);
      const { exitCode, reloaded } = yield* spawnSupervisedChild(argv, reloadSignal);

      if (reloaded) {
        out.info("watchdog: reloading child after source change");
        continue;
      }

      if (exitCode === RESTART_EXIT_CODE) {
        out.info("watchdog: child requested restart");
        continue;
      }

      if (shouldStopSupervisor(exitCode)) {
        process.exitCode = exitCode === 0 ? 0 : exitCode;
        return;
      }

      if (options.restartOnCrash && isCrashExit(exitCode)) {
        out.warn(
          `watchdog: child crashed (exit ${exitCode}) — restarting in 2s`,
        );
        yield* Effect.sleep(CRASH_BACKOFF);
        continue;
      }

      process.exitCode = exitCode;
      return;
    }
  });
