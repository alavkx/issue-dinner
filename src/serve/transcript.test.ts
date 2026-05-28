import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as Effect from "effect/Effect";
import * as FileSystem from "@effect/platform/FileSystem";
import { runEffect } from "../effect/test-runtime.js";
import {
  appendSessionHistory,
  appendTranscript,
  appendTranscriptLine,
  openTranscript,
  tailSessionHistory,
} from "./transcript.js";

describe("transcript", () => {
  it("appends issue transcript lines", () =>
    runEffect(
      Effect.gen(function* () {
        const epic = "TEST-EPIC";
        const transcript = yield* openTranscript(epic, "TEST-1");
        yield* appendTranscriptLine(transcript, "hello");
        yield* appendTranscript(transcript, "world\n");
        const fs = yield* FileSystem.FileSystem;
        const content = yield* fs.readFileString(transcript.path);
        assert.match(content, /hello/);
        assert.match(content, /world/);
      }),
    ));

  it("tails session history", () =>
    runEffect(
      Effect.gen(function* () {
        const epic = `TEST-${Date.now()}`;
        yield* appendSessionHistory(epic, "alpha\n");
        yield* appendSessionHistory(epic, "beta\n");
        const tail = yield* tailSessionHistory(epic, 5);
        assert.match(tail, /alpha/);
        assert.match(tail, /beta/);
      }),
    ));
});
