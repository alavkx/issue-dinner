import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  layer as makeStateStoreLayer,
  StateStore,
  type BlockerPolicy,
} from "./state/store.js";

/** XDG-style state dir; works when the CLI is installed globally (any cwd). */
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

export function resolveCliExecutable(): string {
  const entry = process.argv[1];
  if (!entry) return "issue-dinner";
  return existsSync(entry) ? resolve(entry) : "issue-dinner";
}
