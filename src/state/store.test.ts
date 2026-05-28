import assert from "node:assert/strict";
import * as FileSystem from "@effect/platform/FileSystem";
import * as Effect from "effect/Effect";
import { describe, it } from "node:test";
import { runEffect } from "../effect/test-runtime.js";
import { StateStore, layer as stateStoreLayer } from "./store.js";

function withTempStore<A>(
  blockerPolicy: "strict" | "agent_complete" = "strict",
  run: Effect.Effect<A, unknown, StateStore>,
): Promise<A> {
  return runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectory({ prefix: "issue-dinner-" });
      return yield* run.pipe(Effect.provide(stateStoreLayer(dir, blockerPolicy)));
    }),
  );
}

describe("StateStore.isDone", () => {
  it("treats only verified and skipped as done for blocker gating", () =>
    withTempStore("strict", Effect.gen(function* () {
      const store = yield* StateStore;
      yield* store.upsert({
        issueKey: "CPD-636",
        summary: "x",
        status: "agent_complete",
      });
      assert.equal(yield* store.isDone("CPD-636"), false);

      yield* store.upsert({
        issueKey: "CPD-636",
        summary: "x",
        status: "verified",
      });
      assert.equal(yield* store.isDone("CPD-636"), true);
    })));

  it("treats agent_complete as done when blockerPolicy is agent_complete", () =>
    withTempStore("agent_complete", Effect.gen(function* () {
      const store = yield* StateStore;
      yield* store.upsert({
        issueKey: "CPD-636",
        summary: "x",
        status: "agent_complete",
      });
      assert.equal(yield* store.isDone("CPD-636"), true);
    })));

  it("appendResolutionStep accumulates steps", () =>
    withTempStore("strict", Effect.gen(function* () {
      const store = yield* StateStore;
      yield* store.setEpic("CPD-635");
      yield* store.appendResolutionStep("CPD-637", "first");
      yield* store.appendResolutionStep("CPD-637", "second");
      assert.deepEqual((yield* store.get("CPD-637"))?.resolutionSteps, [
        "first",
        "second",
      ]);
    })));

  it("recovers stale running records", () =>
    withTempStore("strict", Effect.gen(function* () {
      const store = yield* StateStore;
      yield* store.upsert({
        issueKey: "CPD-636",
        summary: "x",
        status: "running",
      });
      const recovered = yield* store.recoverStaleRunning();
      assert.deepEqual(recovered, ["CPD-636"]);
      assert.equal((yield* store.get("CPD-636"))?.status, "error");
    })));

  it("treats empty runs.json as default state", () =>
    runEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const dir = yield* fs.makeTempDirectory({ prefix: "issue-dinner-" });
        yield* fs.writeFileString(`${dir}/runs.json`, "");
        return yield* Effect.gen(function* () {
          const store = yield* StateStore;
          assert.equal((yield* store.get("CPD-636")), undefined);
        }).pipe(Effect.provide(stateStoreLayer(dir)));
      }),
    ));
});
