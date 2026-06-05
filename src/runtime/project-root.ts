import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as FileSystem from "@effect/platform/FileSystem";
import * as Effect from "effect/Effect";

export const ISSUE_DINNER_ROOT_ENV = "ISSUE_DINNER_ROOT";

export const PACKAGE_NAME_MARKER = '"name": "issue-dinner"';

export const moduleIssueDinnerRoot = (): string =>
  resolve(join(dirname(fileURLToPath(import.meta.url)), "../.."));

const findIssueDinnerRootFrom = (
  fs: FileSystem.FileSystem,
  startDir: string,
): Effect.Effect<string | undefined, import("@effect/platform/Error").PlatformError> =>
  Effect.gen(function* () {
    let dir = resolve(startDir);
    for (let depth = 0; depth < 12; depth++) {
      const pkgPath = join(dir, "package.json");
      if (yield* fs.exists(pkgPath)) {
        const content = yield* fs.readFileString(pkgPath);
        const match = content.match(/"name"\s*:\s*"([^"]+)"/);
        if (match?.[1] === "issue-dinner") {
          return dir;
        }
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    return undefined;
  });

/** Resolve the issue-dinner install root (for self-heal + rebuild). */
export const resolveProjectRoot = (): Effect.Effect<
  string,
  import("@effect/platform/Error").PlatformError,
  FileSystem.FileSystem
> =>
  Effect.gen(function* () {
    const fromEnv = process.env[ISSUE_DINNER_ROOT_ENV]?.trim();
    if (fromEnv) return resolve(fromEnv);

    const fs = yield* FileSystem.FileSystem;
    const fromModule = yield* findIssueDinnerRootFrom(fs, moduleIssueDinnerRoot());
    if (fromModule) return fromModule;

    const entry = process.argv[1];
    if (entry) {
      const fromEntry = yield* findIssueDinnerRootFrom(fs, dirname(resolve(entry)));
      if (fromEntry) return fromEntry;
    }

    return moduleIssueDinnerRoot();
  });

export const projectSrcDir = (root: string): string => join(root, "src");
