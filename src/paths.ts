import { homedir } from "node:os";
import { join, resolve } from "node:path";
import * as FileSystem from "@effect/platform/FileSystem";
import * as Effect from "effect/Effect";
import {
  layer as makeStateStoreLayer,
  StateStore,
  type BlockerPolicy,
} from "./state/store.js";

/**
 * XDG-style state dir; works when the CLI is installed globally (any cwd).
 * Runtime state does not live in the issue-dinner source tree unless
 * ISSUE_DINNER_STATE_DIR is set locally (e.g. dogfooding with `.state/`).
 */
export function defaultStateDir(): string {
  return join(homedir(), ".local", "state", "issue-dinner");
}

export function resolveStateDir(explicit?: string): string {
  if (explicit) return resolve(explicit);
  const fromEnv = process.env.ISSUE_DINNER_STATE_DIR?.trim();
  if (fromEnv) return resolve(fromEnv);
  return defaultStateDir();
}

export function stateDirForEpic(epic: string): string {
  return join(resolveStateDir(), epic.toUpperCase());
}

export const stateStoreLayer = (
  stateDir?: string,
  blockerPolicy?: BlockerPolicy,
) =>
  makeStateStoreLayer(resolveStateDir(stateDir), blockerPolicy ?? "strict");

export const stateStoreLayerForEpic = (
  epic: string,
  blockerPolicy: BlockerPolicy = "strict",
) => makeStateStoreLayer(stateDirForEpic(epic), blockerPolicy);

export { StateStore };

export const resolveCliExecutable = (): Effect.Effect<
  string,
  import("@effect/platform/Error").PlatformError,
  FileSystem.FileSystem
> =>
  Effect.gen(function* () {
    const entry = process.argv[1];
    if (!entry) return "issue-dinner";
    const fs = yield* FileSystem.FileSystem;
    return (yield* fs.exists(entry)) ? resolve(entry) : "issue-dinner";
  });
