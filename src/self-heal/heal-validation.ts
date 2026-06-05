import { CommandFailed } from "../effect/errors.js";
import { runCommand } from "../util/exec.js";
import type * as CommandExecutor from "@effect/platform/CommandExecutor";
import * as FileSystem from "@effect/platform/FileSystem";
import * as Effect from "effect/Effect";
import { join } from "node:path";

export const formatCommandFailure = (err: unknown): string => {
  if (err instanceof CommandFailed) {
    return [err.stderr, err.stdout, err.message].filter(Boolean).join("\n");
  }
  return err instanceof Error ? err.message : String(err);
};

export const readPackageName = (
  root: string,
): Effect.Effect<
  string | undefined,
  import("@effect/platform/Error").PlatformError,
  FileSystem.FileSystem
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const pkgPath = join(root, "package.json");
    if (!(yield* fs.exists(pkgPath))) return undefined;
    const content = yield* fs.readFileString(pkgPath);
    const match = content.match(/"name"\s*:\s*"([^"]+)"/);
    return match?.[1];
  });

export const isIssueDinnerPackageRoot = (
  root: string,
): Effect.Effect<
  boolean,
  import("@effect/platform/Error").PlatformError,
  FileSystem.FileSystem
> =>
  readPackageName(root).pipe(Effect.map((name) => name === "issue-dinner"));

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
