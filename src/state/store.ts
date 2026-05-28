import * as FileSystem from "@effect/platform/FileSystem";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import { join } from "node:path";

export type IssueRunStatus =
  | "pending"
  | "running"
  | "agent_complete"
  | "verified"
  | "finished"
  | "error"
  | "cancelled"
  | "skipped";

export interface IssueRunRecord {
  issueKey: string;
  summary: string;
  status: IssueRunStatus;
  workspace?: string;
  cwd?: string;
  agentId?: string;
  runId?: string;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
  verifyError?: string;
  resultPreview?: string;
  handoffStatus?: string;
  handoffVerification?: string;
  verifyOutput?: string;
  /** workspace key → branch name after checkout */
  branches?: Record<string, string>;
  /** workspace key → short commit sha after WIP commit */
  commits?: Record<string, string>;
  /** Human-readable recovery / interruption trail for status and resume */
  resolutionSteps?: string[];
  transcriptPath?: string;
}

export interface DinnerState {
  version: 1;
  epic?: string;
  issues: Record<string, IssueRunRecord>;
}

const DEFAULT_STATE: DinnerState = { version: 1, issues: {} };

export type BlockerPolicy = "strict" | "agent_complete";

export interface StateStoreService {
  readonly get: (key: string) => Effect.Effect<IssueRunRecord | undefined>;
  readonly list: () => Effect.Effect<ReadonlyArray<IssueRunRecord>>;
  readonly setEpic: (epic: string) => Effect.Effect<void>;
  readonly upsert: (record: IssueRunRecord) => Effect.Effect<void>;
  readonly appendResolutionStep: (
    issueKey: string,
    step: string,
  ) => Effect.Effect<void>;
  readonly isDone: (key: string) => Effect.Effect<boolean>;
  readonly isVerified: (key: string) => Effect.Effect<boolean>;
  readonly canProcess: (
    issueKey: string,
    blockedBy: ReadonlyArray<string>,
  ) => Effect.Effect<{ ok: boolean; reason?: string }>;
  readonly recoverStaleRunning: () => Effect.Effect<ReadonlyArray<string>>;
  readonly setBlockerPolicy: (policy: BlockerPolicy) => Effect.Effect<void>;
}

export class StateStore extends Context.Tag("issue-dinner/StateStore")<
  StateStore,
  StateStoreService
>() {}

function loadState(
  fs: FileSystem.FileSystem,
  path: string,
): Effect.Effect<DinnerState> {
  return fs.exists(path).pipe(
    Effect.flatMap((exists) => {
      if (!exists) return Effect.succeed(structuredClone(DEFAULT_STATE));
      return fs.readFileString(path).pipe(
        Effect.map((raw) => JSON.parse(raw) as DinnerState),
        Effect.catchAll(() => Effect.succeed(structuredClone(DEFAULT_STATE))),
      );
    }),
    Effect.catchAll(() => Effect.succeed(structuredClone(DEFAULT_STATE))),
  );
}

function saveState(
  fs: FileSystem.FileSystem,
  path: string,
  data: DinnerState,
): Effect.Effect<void> {
  return fs
    .writeFileString(path, JSON.stringify(data, null, 2))
    .pipe(Effect.catchAll(() => Effect.void));
}

export const makeStateStore = (
  stateDir: string,
  blockerPolicy: BlockerPolicy = "strict",
): Effect.Effect<StateStoreService, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs
      .makeDirectory(stateDir, { recursive: true })
      .pipe(Effect.catchAll(() => Effect.void));
    const path = join(stateDir, "runs.json");
    const initial = yield* loadState(fs, path);
    const dataRef = yield* Ref.make(initial);
    const policyRef = yield* Ref.make<BlockerPolicy>(blockerPolicy);

    const persist = Effect.gen(function* () {
      const data = yield* Ref.get(dataRef);
      yield* saveState(fs, path, data);
    });

    const isDoneFor = (
      data: DinnerState,
      policy: BlockerPolicy,
      key: string,
    ): boolean => {
      const s = data.issues[key]?.status;
      if (s === "verified" || s === "finished" || s === "skipped") return true;
      if (policy === "agent_complete" && s === "agent_complete") return true;
      return false;
    };

    return {
      get: (key) =>
        Ref.get(dataRef).pipe(Effect.map((data) => data.issues[key])),

      list: () =>
        Ref.get(dataRef).pipe(Effect.map((data) => Object.values(data.issues))),

      setEpic: (epic) =>
        Effect.gen(function* () {
          yield* Ref.update(dataRef, (data) => ({ ...data, epic }));
          yield* persist;
        }),

      upsert: (record) =>
        Effect.gen(function* () {
          yield* Ref.update(dataRef, (data) => {
            const prev = data.issues[record.issueKey];
            const next =
              prev?.resolutionSteps && record.resolutionSteps === undefined
                ? { ...record, resolutionSteps: prev.resolutionSteps }
                : record;
            return {
              ...data,
              issues: { ...data.issues, [record.issueKey]: next },
            };
          });
          yield* persist;
        }),

      appendResolutionStep: (issueKey, step) =>
        Effect.gen(function* () {
          yield* Ref.update(dataRef, (data) => {
            const rec = data.issues[issueKey];
            const steps = [...(rec?.resolutionSteps ?? []), step];
            if (rec) {
              return {
                ...data,
                issues: {
                  ...data.issues,
                  [issueKey]: { ...rec, resolutionSteps: steps },
                },
              };
            }
            return {
              ...data,
              issues: {
                ...data.issues,
                [issueKey]: {
                  issueKey,
                  summary: issueKey,
                  status: "pending" as const,
                  resolutionSteps: steps,
                },
              },
            };
          });
          yield* persist;
        }),

      isDone: (key) =>
        Effect.gen(function* () {
          const [data, policy] = yield* Effect.all([
            Ref.get(dataRef),
            Ref.get(policyRef),
          ]);
          return isDoneFor(data, policy, key);
        }),

      isVerified: (key) =>
        Ref.get(dataRef).pipe(
          Effect.map((data) => {
            const s = data.issues[key]?.status;
            return s === "verified" || s === "finished";
          }),
        ),

      canProcess: (issueKey, blockedBy) =>
        Effect.gen(function* () {
          const [data, policy] = yield* Effect.all([
            Ref.get(dataRef),
            Ref.get(policyRef),
          ]);
          for (const blocker of blockedBy) {
            if (!isDoneFor(data, policy, blocker)) {
              return {
                ok: false as const,
                reason: `Blocked by ${blocker} (status: ${data.issues[blocker]?.status ?? "not started"})`,
              };
            }
          }
          return { ok: true as const };
        }),

      recoverStaleRunning: () =>
        Effect.gen(function* () {
          const data = yield* Ref.get(dataRef);
          const recovered: string[] = [];
          const nextIssues = { ...data.issues };
          for (const [key, rec] of Object.entries(data.issues)) {
            if (rec.status === "running") {
              const steps = [
                ...(rec.resolutionSteps ?? []),
                "Serve interrupted while issue was running (crash, Ctrl+C, or agent stall)",
                `Resume: issue-dinner ${data.epic ?? "EPIC"} serve --only ${key}` +
                  `  # or cook ${key} --force`,
              ];
              nextIssues[key] = {
                ...rec,
                status: "error",
                error: "Recovered stale running state (previous serve interrupted)",
                resolutionSteps: steps,
                finishedAt: new Date().toISOString(),
              };
              recovered.push(key);
            }
          }
          if (recovered.length > 0) {
            yield* Ref.set(dataRef, { ...data, issues: nextIssues });
            yield* persist;
          }
          return recovered;
        }),

      setBlockerPolicy: (policy) => Ref.set(policyRef, policy),
    };
  });

export const layer = (
  stateDir: string,
  blockerPolicy: BlockerPolicy = "strict",
): Layer.Layer<StateStore, never, FileSystem.FileSystem> =>
  Layer.effect(StateStore, makeStateStore(stateDir, blockerPolicy));
