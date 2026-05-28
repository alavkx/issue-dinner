import * as FileSystem from "@effect/platform/FileSystem";
import * as Effect from "effect/Effect";
import { join } from "node:path";
import { stateDirForEpic } from "../paths.js";

type PlatformError = import("@effect/platform/Error").PlatformError;

export interface Transcript {
  readonly path: string;
  readonly epic: string;
  readonly issueKey: string;
}

export const sessionHistoryPath = (epic: string): string =>
  join(stateDirForEpic(epic), "session-history.log");

export const openTranscript = (
  epic: string,
  issueKey: string,
): Effect.Effect<Transcript, PlatformError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = join(stateDirForEpic(epic), "transcripts");
    yield* fs.makeDirectory(dir, { recursive: true });
    return {
      path: join(dir, `${issueKey}.log`),
      epic,
      issueKey,
    };
  });

export const appendTranscript = (
  transcript: Transcript,
  text: string,
): Effect.Effect<void, PlatformError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.writeFileString(transcript.path, text, { flag: "a" });
  });

export const appendTranscriptLine = (
  transcript: Transcript,
  line: string,
): Effect.Effect<void, PlatformError, FileSystem.FileSystem> => {
  const ts = new Date().toISOString();
  return appendTranscript(transcript, `[${ts}] ${line}\n`);
};

export const appendTranscriptBlock = (
  transcript: Transcript,
  label: string,
  body: string,
): Effect.Effect<void, PlatformError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    yield* appendTranscriptLine(transcript, `── ${label} ──`);
    for (const line of body.split("\n")) {
      yield* appendTranscript(transcript, `  ${line}\n`);
    }
  });

export const appendSessionHistory = (
  epic: string,
  text: string,
): Effect.Effect<void, PlatformError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = stateDirForEpic(epic);
    yield* fs.makeDirectory(dir, { recursive: true });
    yield* fs.writeFileString(sessionHistoryPath(epic), text, { flag: "a" });
  });

export const tailSessionHistory = (
  epic: string,
  lines = 80,
): Effect.Effect<string, PlatformError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = sessionHistoryPath(epic);
    const exists = yield* fs.exists(path);
    if (!exists) return "";
    const content = yield* fs.readFileString(path);
    return content.split("\n").slice(-lines).join("\n");
  });

export const formatAttachReplay = (
  epic: string,
  lines = 80,
): Effect.Effect<string, PlatformError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const tail = yield* tailSessionHistory(epic, lines);
    if (!tail.trim()) return "";
    return [
      "",
      "──────────────── recent session history ────────────────",
      tail,
      "──────────────── live output below ───────────────────",
      "",
    ].join("\n");
  });
