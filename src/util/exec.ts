import * as Command from "@effect/platform/Command";
import type * as CommandExecutor from "@effect/platform/CommandExecutor";
import * as Chunk from "effect/Chunk";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { CommandFailed } from "../effect/errors.js";

export { CommandFailed };

const readStreamAsString = (
  stream: Stream.Stream<Uint8Array, import("@effect/platform/Error").PlatformError>,
): Effect.Effect<string, import("@effect/platform/Error").PlatformError> =>
  Stream.runCollect(stream).pipe(
    Effect.map((chunks) => {
      const decoder = new TextDecoder();
      return Chunk.reduce(chunks, "", (acc, chunk) => acc + decoder.decode(chunk));
    }),
  );

export const runCommand = (
  command: string,
  args: ReadonlyArray<string>,
  options?: { cwd?: string },
): Effect.Effect<
  { stdout: string; stderr: string },
  CommandFailed | import("@effect/platform/Error").PlatformError,
  CommandExecutor.CommandExecutor
> =>
  Effect.scoped(
    Effect.gen(function* () {
      let cmd = Command.make(command, ...args);
      if (options?.cwd) {
        cmd = Command.workingDirectory(cmd, options.cwd);
      }

      const process = yield* Command.start(cmd);
      const [stdout, stderr, exitCode] = yield* Effect.all(
        [readStreamAsString(process.stdout), readStreamAsString(process.stderr), process.exitCode],
        { concurrency: "unbounded" },
      );

      if (exitCode !== 0) {
        return yield* Effect.fail(
          new CommandFailed({
            command,
            args: [...args],
            code: exitCode,
            stdout,
            stderr,
            message: `${command} exited with code ${exitCode}`,
          }),
        );
      }

      return { stdout, stderr };
    }),
  );

/** Safe single-quoted shell argument (falls back when special chars present). */
export function shellQuote(arg: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(arg)) return arg;
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

export const commandExists = (
  command: string,
): Effect.Effect<boolean, never, CommandExecutor.CommandExecutor> =>
  Command.exitCode(Command.make("which", command)).pipe(
    Effect.map((code) => code === 0),
    Effect.catchAll(() => Effect.succeed(false)),
  );
