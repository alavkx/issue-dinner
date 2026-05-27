import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { StateStore } from "./state/store.js";

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

export function stateStore(stateDir?: string): StateStore {
  const dir = resolveStateDir(stateDir);
  mkdirSync(dir, { recursive: true });
  return new StateStore(dir);
}

export function stateDirForEpic(epic: string): string {
  return join(resolveStateDir(), epic.toUpperCase());
}

export function stateStoreForEpic(epic: string): StateStore {
  return stateStore(stateDirForEpic(epic));
}

export function resolveCliExecutable(): string {
  const entry = process.argv[1];
  if (!entry) return "issue-dinner";
  return existsSync(entry) ? resolve(entry) : "issue-dinner";
}
