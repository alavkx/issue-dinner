import { dirname, join } from "node:path";
import { defaultStateDir } from "../paths.js";
import {
  KitchenPatchManifest,
  MANIFEST_FILE,
  kitchenApplied,
  validatePatchPath,
} from "./patch.js";
import * as FileSystem from "@effect/platform/FileSystem";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

/** User-state directory for heals that survive npm reinstalls. */
export function durableHealDir(): string {
  return join(defaultStateDir(), "heals");
}

export function durableHealPatchDir(patchId: string): string {
  return join(durableHealDir(), patchId);
}

const listHealPatchIds = (
  fs: FileSystem.FileSystem,
): Effect.Effect<ReadonlyArray<string>, import("@effect/platform/Error").PlatformError> =>
  Effect.gen(function* () {
    const dir = durableHealDir();
    if (!(yield* fs.exists(dir))) return [];
    return (yield* fs.readDirectory(dir)).filter((name) => !name.startsWith("."));
  });

export const readDurableManifest = (
  patchId: string,
): Effect.Effect<
  KitchenPatchManifest,
  import("@effect/platform/Error").PlatformError | Error,
  FileSystem.FileSystem
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const manifestPath = join(durableHealPatchDir(patchId), MANIFEST_FILE);
    if (!(yield* fs.exists(manifestPath))) {
      return yield* Effect.fail(
        new Error(`Missing durable heal manifest: ${manifestPath}`),
      );
    }
    const raw = yield* fs.readFileString(manifestPath);
    const parsed = JSON.parse(raw) as unknown;
    return yield* Schema.decodeUnknown(KitchenPatchManifest)(parsed).pipe(
      Effect.mapError((err) => new Error(String(err))),
    );
  });

/** Snapshot all TypeScript files under `src/` in the package root. */
export const snapshotSrcFiles = (
  packageRoot: string,
): Effect.Effect<
  Map<string, string>,
  import("@effect/platform/Error").PlatformError,
  FileSystem.FileSystem
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const srcDir = join(packageRoot, "src");
    const files = new Map<string, string>();

    const walk = (
      dir: string,
      relPrefix: string,
    ): Effect.Effect<void, import("@effect/platform/Error").PlatformError> =>
      Effect.gen(function* () {
        if (!(yield* fs.exists(dir))) return;
        for (const name of yield* fs.readDirectory(dir)) {
          const abs = join(dir, name);
          const rel = relPrefix ? `${relPrefix}/${name}` : name;
          const stat = yield* fs.stat(abs);
          if (stat.type === "Directory") {
            yield* walk(abs, rel);
          } else if (rel.endsWith(".ts")) {
            files.set(`src/${rel}`, yield* fs.readFileString(abs));
          }
        }
      });

    yield* walk(srcDir, "");
    return files;
  });

/** Files whose content differs from the baseline snapshot. */
export function diffSrcSnapshot(
  baseline: ReadonlyMap<string, string>,
  current: ReadonlyMap<string, string>,
): ReadonlyArray<{ path: string; content: string }> {
  const changed: Array<{ path: string; content: string }> = [];
  for (const [path, content] of current) {
    if (baseline.get(path) !== content) {
      changed.push({ path, content });
    }
  }
  for (const path of baseline.keys()) {
    if (!current.has(path)) {
      changed.push({ path, content: "" });
    }
  }
  return changed;
}

export const persistDurableHeal = (
  manifest: KitchenPatchManifest,
): Effect.Effect<void, import("@effect/platform/Error").PlatformError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const patchDir = durableHealPatchDir(manifest.id);
    yield* fs.makeDirectory(patchDir, { recursive: true });
    yield* fs.writeFileString(
      join(patchDir, MANIFEST_FILE),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
  });

export const applyManifestToPackage = (
  packageRoot: string,
  manifest: KitchenPatchManifest,
): Effect.Effect<
  ReadonlyArray<string>,
  import("@effect/platform/Error").PlatformError | import("./patch.js").KitchenPatchInvalid,
  FileSystem.FileSystem
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const touched: string[] = [];
    for (const file of manifest.files) {
      const relPath = yield* validatePatchPath(file.path);
      touched.push(relPath);
      const absPath = join(packageRoot, relPath);
      if (file.content === "") {
        if (yield* fs.exists(absPath)) {
          yield* fs.remove(absPath);
        }
      } else {
        yield* fs.makeDirectory(dirname(absPath), { recursive: true });
        yield* fs.writeFileString(absPath, file.content);
      }
    }
    return touched;
  });

/** Sync all durable heals into the installed package (newest id wins per file). */
export const syncDurableHealsToPackage = (
  packageRoot: string,
): Effect.Effect<
  ReadonlyArray<string>,
  | import("@effect/platform/Error").PlatformError
  | import("./patch.js").KitchenPatchInvalid,
  FileSystem.FileSystem
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const ids = [...(yield* listHealPatchIds(fs))].sort();
    const synced: string[] = [];
    for (const id of ids) {
      const manifest = yield* readDurableManifest(id).pipe(
        Effect.catchAll(() => Effect.succeed(undefined)),
      );
      if (!manifest) continue;
      yield* applyManifestToPackage(packageRoot, manifest);
      synced.push(id);
    }
    return synced;
  });

export const listDurableHealIds = (): Effect.Effect<
  ReadonlyArray<string>,
  import("@effect/platform/Error").PlatformError,
  FileSystem.FileSystem
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return yield* listHealPatchIds(fs);
  });

export const listDurableHealManifests = (): Effect.Effect<
  ReadonlyArray<KitchenPatchManifest>,
  import("@effect/platform/Error").PlatformError,
  FileSystem.FileSystem
> =>
  Effect.gen(function* () {
    const ids = yield* listDurableHealIds();
    const manifests: KitchenPatchManifest[] = [];
    for (const id of ids) {
      const manifest = yield* readDurableManifest(id).pipe(
        Effect.catchAll(() => Effect.succeed(undefined)),
      );
      if (manifest) manifests.push(manifest);
    }
    return manifests;
  });

export const recordHealInKitchenApplied = (
  packageRoot: string,
  manifest: KitchenPatchManifest,
): Effect.Effect<void, import("@effect/platform/Error").PlatformError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const patchDir = join(kitchenApplied(packageRoot), manifest.id);
    yield* fs.makeDirectory(patchDir, { recursive: true });
    yield* fs.writeFileString(
      join(patchDir, MANIFEST_FILE),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
  });
