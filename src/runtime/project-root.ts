import { dirname, join, resolve } from "node:path";
import * as FileSystem from "@effect/platform/FileSystem";
import * as Effect from "effect/Effect";

export const ISSUE_DINNER_ROOT_ENV = "ISSUE_DINNER_ROOT";

const PACKAGE_NAME_MARKER = '"name": "issue-dinner"';

/** Resolve the issue-dinner install root (for kitchen + rebuild). */
export const resolveProjectRoot = (): Effect.Effect<
  string,
  import("@effect/platform/Error").PlatformError,
  FileSystem.FileSystem
> =>
  Effect.gen(function* () {
    const fromEnv = process.env[ISSUE_DINNER_ROOT_ENV]?.trim();
    if (fromEnv) return resolve(fromEnv);

    const fs = yield* FileSystem.FileSystem;
    const entry = process.argv[1];
    let dir = entry ? dirname(resolve(entry)) : process.cwd();

    for (let depth = 0; depth < 12; depth++) {
      const pkgPath = join(dir, "package.json");
      if (yield* fs.exists(pkgPath)) {
        const content = yield* fs.readFileString(pkgPath);
        if (content.includes(PACKAGE_NAME_MARKER)) {
          return dir;
        }
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }

    return process.cwd();
  });

export const projectSrcDir = (root: string): string => join(root, "src");
