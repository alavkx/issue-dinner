import * as FileSystem from "@effect/platform/FileSystem";
import type * as CommandExecutor from "@effect/platform/CommandExecutor";
import * as Effect from "effect/Effect";
import { relative, resolve } from "node:path";
import { CommandFailed } from "../effect/errors.js";
import { runCommand } from "../util/exec.js";

const ISTARI_CLIENT = "@istari/istari-client";

export interface LinkLocalSdkResult {
  frontendCwd: string;
  sdkCwd: string;
  linked: boolean;
  detail: string;
}

const fileDependencySpec = (frontendCwd: string, sdkCwd: string): string => {
  const rel = relative(frontendCwd, resolve(sdkCwd));
  if (rel === "") return "file:.";
  return rel.startsWith(".") ? `file:${rel}` : `file:./${rel}`;
};

/** Point frontend at the local istari-ts-client checkout for stacked epic work. */
export const ensureLocalSdkLink = (
  frontendCwd: string,
  sdkCwd: string,
): Effect.Effect<
  LinkLocalSdkResult,
  import("@effect/platform/Error").PlatformError | CommandFailed,
  FileSystem.FileSystem | CommandExecutor.CommandExecutor
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const pkgPath = resolve(frontendCwd, "package.json");
    const raw = yield* fs.readFileString(pkgPath);
    const pkg = JSON.parse(raw) as {
      dependencies?: Record<string, string>;
    };
    const spec = fileDependencySpec(frontendCwd, sdkCwd);
    const current = pkg.dependencies?.[ISTARI_CLIENT];
    if (current === spec) {
      return {
        frontendCwd,
        sdkCwd,
        linked: true,
        detail: `already ${spec}`,
      };
    }

    pkg.dependencies = { ...pkg.dependencies, [ISTARI_CLIENT]: spec };
    yield* fs.writeFileString(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);

    const installOutcome = yield* Effect.either(
      runCommand("npm", ["install"], { cwd: frontendCwd }),
    );
    if (installOutcome._tag === "Left") {
      const err = installOutcome.left;
      const msg =
        err instanceof CommandFailed
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err);
      return { frontendCwd, sdkCwd, linked: false, detail: msg };
    }

    return { frontendCwd, sdkCwd, linked: true, detail: spec };
  });
