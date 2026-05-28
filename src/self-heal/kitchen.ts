import { dirname, join } from "node:path";
import * as FileSystem from "@effect/platform/FileSystem";
import type * as CommandExecutor from "@effect/platform/CommandExecutor";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { resolveProjectRoot } from "../runtime/project-root.js";
import { requestRestart } from "../runtime/relaunch.js";
import { runCommand } from "../util/exec.js";
import * as out from "../ui/out.js";
import {
  KitchenApplyFailed,
  KitchenPatchInvalid,
  KitchenPatchManifest,
  MANIFEST_FILE,
  kitchenApplied,
  kitchenDir,
  kitchenFailed,
  kitchenInbox,
  validatePatchPath,
} from "./patch.js";

export interface KitchenBuildCommands {
  readonly validate: (
    root: string,
    patchId: string,
  ) => Effect.Effect<
    void,
    KitchenApplyFailed,
    CommandExecutor.CommandExecutor
  >;
}

export class KitchenBuildPort extends Context.Tag("issue-dinner/KitchenBuildPort")<
  KitchenBuildPort,
  KitchenBuildCommands
>() {}

const defaultBuildCommands: KitchenBuildCommands = {
  validate: (root, patchId) =>
    Effect.gen(function* () {
      yield* runCommand("npm", ["run", "typecheck"], { cwd: root }).pipe(
        Effect.mapError(
          (err) =>
            new KitchenApplyFailed({
              patchId,
              message:
                "message" in err
                  ? String(err.message)
                  : `typecheck failed for patch ${patchId}`,
            }),
        ),
      );
      yield* runCommand("npm", ["run", "build"], { cwd: root }).pipe(
        Effect.mapError(
          (err) =>
            new KitchenApplyFailed({
              patchId,
              message:
                "message" in err
                  ? String(err.message)
                  : `build failed for patch ${patchId}`,
            }),
        ),
      );
    }),
};

export const KitchenBuildPortLive = Layer.succeed(KitchenBuildPort, defaultBuildCommands);

export interface KitchenPatchSummary {
  readonly id: string;
  readonly issueKey?: string;
  readonly reason?: string;
  readonly fileCount: number;
}

export interface KitchenStatus {
  readonly root: string;
  readonly inbox: ReadonlyArray<KitchenPatchSummary>;
  readonly applied: ReadonlyArray<string>;
  readonly failed: ReadonlyArray<string>;
}

export interface ProcessKitchenOptions {
  readonly dryRun?: boolean;
  readonly restart?: boolean;
  readonly argv?: ReadonlyArray<string>;
}

export interface ProcessKitchenResult {
  readonly applied: ReadonlyArray<string>;
  readonly failed: ReadonlyArray<string>;
  readonly restarted: boolean;
}

const ensureKitchenDirs = (
  root: string,
): Effect.Effect<void, import("@effect/platform/Error").PlatformError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    for (const dir of [kitchenDir(root), kitchenInbox(root), kitchenApplied(root), kitchenFailed(root)]) {
      yield* fs.makeDirectory(dir, { recursive: true });
    }
  });

const readManifest = (
  patchDir: string,
): Effect.Effect<
  KitchenPatchManifest,
  KitchenPatchInvalid | import("@effect/platform/Error").PlatformError,
  FileSystem.FileSystem
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const manifestPath = join(patchDir, MANIFEST_FILE);
    if (!(yield* fs.exists(manifestPath))) {
      return yield* Effect.fail(
        new KitchenPatchInvalid({
          message: `Missing ${MANIFEST_FILE} in ${patchDir}`,
        }),
      );
    }
    const raw = yield* fs.readFileString(manifestPath);
    const parsed = yield* Effect.try({
      try: () => JSON.parse(raw) as unknown,
      catch: (err) =>
        new KitchenPatchInvalid({
          message: `Invalid JSON in ${patchDir}: ${String(err)}`,
        }),
    });
    const decoded = yield* Schema.decodeUnknown(KitchenPatchManifest)(parsed).pipe(
      Effect.mapError(
        (err) =>
          new KitchenPatchInvalid({
            message: `Invalid manifest in ${patchDir}: ${String(err)}`,
          }),
      ),
    );
    return decoded;
  });

const listPatchDirs = (
  dir: string,
): Effect.Effect<
  ReadonlyArray<string>,
  import("@effect/platform/Error").PlatformError,
  FileSystem.FileSystem
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    if (!(yield* fs.exists(dir))) return [];
    const entries = yield* fs.readDirectory(dir);
    return entries.filter((name) => !name.startsWith("."));
  });

const movePatchDir = (
  fromDir: string,
  toParent: string,
  name: string,
): Effect.Effect<void, import("@effect/platform/Error").PlatformError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.rename(fromDir, join(toParent, name));
  });

const backupAndWrite = (
  root: string,
  relPath: string,
  content: string,
  backups: Map<string, string | null>,
): Effect.Effect<void, import("@effect/platform/Error").PlatformError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const absPath = join(root, relPath);
    if (!backups.has(relPath)) {
      if (yield* fs.exists(absPath)) {
        backups.set(relPath, yield* fs.readFileString(absPath));
      } else {
        backups.set(relPath, null);
      }
    }
    yield* fs.makeDirectory(dirname(absPath), { recursive: true });
    yield* fs.writeFileString(absPath, content);
  });

const restoreBackups = (
  root: string,
  backups: Map<string, string | null>,
): Effect.Effect<void, import("@effect/platform/Error").PlatformError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    for (const [relPath, previous] of backups) {
      const absPath = join(root, relPath);
      if (previous === null) {
        if (yield* fs.exists(absPath)) {
          yield* fs.remove(absPath);
        }
      } else {
        yield* fs.writeFileString(absPath, previous);
      }
    }
  });

const applyPatchManifest = (
  root: string,
  manifest: KitchenPatchManifest,
  dryRun: boolean,
): Effect.Effect<
  ReadonlyArray<string>,
  KitchenPatchInvalid | KitchenApplyFailed | import("@effect/platform/Error").PlatformError,
  FileSystem.FileSystem
> =>
  Effect.gen(function* () {
    const touched: string[] = [];
    for (const file of manifest.files) {
      const relPath = yield* validatePatchPath(file.path);
      touched.push(relPath);
      if (!dryRun) {
        const fs = yield* FileSystem.FileSystem;
        const absPath = join(root, relPath);
        yield* fs.makeDirectory(dirname(absPath), { recursive: true });
        yield* fs.writeFileString(absPath, file.content);
      }
    }
    return touched;
  });

const applySinglePatch = (
  root: string,
  patchName: string,
  options: ProcessKitchenOptions,
): Effect.Effect<
  { ok: true; id: string } | { ok: false; id: string; error: string },
  | import("@effect/platform/Error").PlatformError
  | KitchenPatchInvalid
  | KitchenApplyFailed,
  FileSystem.FileSystem | CommandExecutor.CommandExecutor | KitchenBuildPort
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const patchDir = join(kitchenInbox(root), patchName);
    const manifest = yield* readManifest(patchDir);
    const patchId = manifest.id || patchName;

    if (options.dryRun) {
      yield* applyPatchManifest(root, manifest, true);
      return { ok: true as const, id: patchId };
    }

    const backups = new Map<string, string | null>();
    const writeFiles = Effect.gen(function* () {
      for (const file of manifest.files) {
        const relPath = yield* validatePatchPath(file.path);
        yield* backupAndWrite(root, relPath, file.content, backups);
      }
    });

    const validateAndBuild = Effect.gen(function* () {
      const build = yield* KitchenBuildPort;
      yield* build.validate(root, patchId);
    });

    const outcome = yield* writeFiles.pipe(
      Effect.flatMap(() => validateAndBuild),
      Effect.map(() => ({ ok: true as const, id: patchId })),
      Effect.catchAll((err) =>
        Effect.gen(function* () {
          yield* restoreBackups(root, backups);
          const message =
            err instanceof KitchenApplyFailed
              ? err.message
              : err instanceof Error
                ? err.message
                : String(err);
          if (yield* fs.exists(patchDir)) {
            yield* movePatchDir(patchDir, kitchenFailed(root), patchName).pipe(
              Effect.catchAll(() => Effect.void),
            );
          }
          return { ok: false as const, id: patchId, error: message };
        }),
      ),
    );

    if (outcome.ok) {
      yield* movePatchDir(patchDir, kitchenApplied(root), patchName);
    }
    return outcome;
  });

export const getKitchenStatus = (): Effect.Effect<
  KitchenStatus,
  import("@effect/platform/Error").PlatformError,
  FileSystem.FileSystem
> =>
  Effect.gen(function* () {
    const root = yield* resolveProjectRoot();
    yield* ensureKitchenDirs(root);
    const inboxNames = yield* listPatchDirs(kitchenInbox(root));
    const inbox: KitchenPatchSummary[] = [];
    for (const name of inboxNames) {
      const manifest = yield* readManifest(join(kitchenInbox(root), name)).pipe(
        Effect.catchAll(() => Effect.succeed(undefined)),
      );
      if (manifest) {
        inbox.push({
          id: manifest.id,
          issueKey: manifest.issueKey,
          reason: manifest.reason,
          fileCount: manifest.files.length,
        });
      }
    }
    return {
      root,
      inbox,
      applied: yield* listPatchDirs(kitchenApplied(root)),
      failed: yield* listPatchDirs(kitchenFailed(root)),
    };
  });

export const processKitchenInbox = (
  options: ProcessKitchenOptions = {},
): Effect.Effect<
  ProcessKitchenResult,
  | import("@effect/platform/Error").PlatformError
  | KitchenPatchInvalid
  | KitchenApplyFailed,
  FileSystem.FileSystem | CommandExecutor.CommandExecutor | KitchenBuildPort
> =>
  Effect.gen(function* () {
    const root = yield* resolveProjectRoot();
    yield* ensureKitchenDirs(root);
    const inboxNames = yield* listPatchDirs(kitchenInbox(root));
    if (inboxNames.length === 0) {
      return { applied: [], failed: [], restarted: false };
    }

    const applied: string[] = [];
    const failed: string[] = [];

    for (const name of [...inboxNames].sort()) {
      const result = yield* applySinglePatch(root, name, options);
      if (result.ok) {
        applied.push(result.id);
        out.success(`kitchen: applied patch ${result.id}`);
      } else {
        failed.push(result.id);
        out.error(`kitchen: patch ${result.id} failed — ${result.error}`);
      }
    }

    let restarted = false;
    if (applied.length > 0 && options.restart && options.argv) {
      out.phase("kitchen", "restarting with patched sources");
      restarted = true;
      yield* requestRestart(options.argv);
    }

    return { applied, failed, restarted };
  });

/** Between serve courses: apply inbox patches and restart if anything landed. */
export const runKitchenBetweenCourses = (
  argv: ReadonlyArray<string>,
  label: string,
):   Effect.Effect<
  ProcessKitchenResult,
  | import("@effect/platform/Error").PlatformError
  | KitchenPatchInvalid
  | KitchenApplyFailed,
  FileSystem.FileSystem | CommandExecutor.CommandExecutor | KitchenBuildPort
> =>
  Effect.gen(function* () {
    const status = yield* getKitchenStatus();
    if (status.inbox.length === 0) {
      return { applied: [], failed: [], restarted: false };
    }

    out.phase("kitchen", `${label}: ${status.inbox.length} patch(es) waiting`);
    return yield* processKitchenInbox({ restart: true, argv });
  });

export const formatKitchenStatus = (status: KitchenStatus): string => {
  const lines = [
    `Kitchen root: ${status.root}`,
    `Inbox (${status.inbox.length}):`,
  ];
  if (status.inbox.length === 0) {
    lines.push("  (empty)");
  } else {
    for (const patch of status.inbox) {
      const meta = [
        patch.issueKey ? `from ${patch.issueKey}` : undefined,
        patch.reason,
        `${patch.fileCount} file(s)`,
      ]
        .filter(Boolean)
        .join(" — ");
      lines.push(`  • ${patch.id}${meta ? ` (${meta})` : ""}`);
    }
  }
  lines.push(`Applied: ${status.applied.length ? status.applied.join(", ") : "(none)"}`);
  lines.push(`Failed: ${status.failed.length ? status.failed.join(", ") : "(none)"}`);
  lines.push("");
  lines.push("Drop patches in .issue-dinner/kitchen/inbox/<name>/manifest.json");
  return lines.join("\n");
};

export const kitchenPatchExample = (root: string, issueKey: string): string => {
  const inbox = join(kitchenInbox(root), "example-fix");
  return JSON.stringify(
    {
      id: "example-fix",
      issueKey,
      reason: "Describe what this patch fixes in issue-dinner itself",
      files: [
        {
          path: "src/agent/recovery.ts",
          content: "// patched content here\n",
        },
      ],
    },
    null,
    2,
  );
};
