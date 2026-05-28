import { join } from "node:path";
import { defaultStateDir } from "../paths.js";
import * as FileSystem from "@effect/platform/FileSystem";
import * as Effect from "effect/Effect";

export const HEAL_RESUME_FILE = "heal-resume.json";

export type HealTriggerKind =
  | "orchestration"
  | "agent_error"
  | "verify"
  | "recovery_exhausted"
  | "handoff"
  | "commit";

export interface HealResumeState {
  readonly version: 1;
  readonly epic: string;
  readonly issueKey: string;
  readonly courseIndex: number;
  readonly serveArgv: ReadonlyArray<string>;
  readonly configPath?: string;
  readonly courseAgentId?: string;
  readonly healAgentId?: string;
  readonly trigger: HealTriggerKind;
  readonly failureDetail: string;
  readonly healSessionId: string;
  readonly patchId?: string;
  readonly fixSummary?: string;
  /** After restart, resume the interrupted course. */
  readonly postHealResume: boolean;
}

export function healResumePath(): string {
  return join(defaultStateDir(), HEAL_RESUME_FILE);
}

export const loadHealResume = (): Effect.Effect<
  HealResumeState | undefined,
  import("@effect/platform/Error").PlatformError,
  FileSystem.FileSystem
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = healResumePath();
    if (!(yield* fs.exists(path))) return undefined;
    const raw = yield* fs.readFileString(path);
    try {
      const parsed = JSON.parse(raw) as HealResumeState;
      if (parsed.version !== 1) return undefined;
      return parsed;
    } catch {
      return undefined;
    }
  });

export const saveHealResume = (
  state: HealResumeState,
): Effect.Effect<void, import("@effect/platform/Error").PlatformError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = healResumePath();
    yield* fs.makeDirectory(defaultStateDir(), { recursive: true });
    yield* fs.writeFileString(path, `${JSON.stringify(state, null, 2)}\n`);
  });

export const clearHealResume = (): Effect.Effect<
  void,
  import("@effect/platform/Error").PlatformError,
  FileSystem.FileSystem
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = healResumePath();
    if (yield* fs.exists(path)) {
      yield* fs.remove(path);
    }
  });

export const buildHealSessionId = (issueKey: string): string =>
  `heal-${issueKey}-${Date.now()}`;
