import { CommandFailed } from "../effect/errors.js";
import { runCommand } from "../util/exec.js";
import type * as CommandExecutor from "@effect/platform/CommandExecutor";
import * as Effect from "effect/Effect";

export const formatCommandFailure = (err: unknown): string => {
  if (err instanceof CommandFailed) {
    return [err.stderr, err.stdout, err.message].filter(Boolean).join("\n");
  }
  return err instanceof Error ? err.message : String(err);
};

export const runTypecheck = (
  root: string,
): Effect.Effect<
  { ok: true } | { ok: false; output: string },
  import("@effect/platform/Error").PlatformError,
  CommandExecutor.CommandExecutor
> =>
  runCommand("npm", ["run", "typecheck"], { cwd: root }).pipe(
    Effect.map(() => ({ ok: true as const })),
    Effect.catchAll((err) =>
      Effect.succeed({ ok: false as const, output: formatCommandFailure(err) }),
    ),
  );

export const runBuild = (
  root: string,
): Effect.Effect<
  { ok: true } | { ok: false; output: string },
  import("@effect/platform/Error").PlatformError,
  CommandExecutor.CommandExecutor
> =>
  runCommand("npm", ["run", "build"], { cwd: root }).pipe(
    Effect.map(() => ({ ok: true as const })),
    Effect.catchAll((err) =>
      Effect.succeed({ ok: false as const, output: formatCommandFailure(err) }),
    ),
  );
