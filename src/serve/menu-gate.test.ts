import assert from "node:assert/strict";
import * as Effect from "effect/Effect";
import { describe, it } from "node:test";
import type { JiraIssue } from "../jira/acli.js";
import { runEffect } from "../effect/test-runtime.js";
import { StateStore, layer as stateStoreLayer } from "../state/store.js";
import { menuOrderBlocks } from "./menu-gate.js";
import * as FileSystem from "@effect/platform/FileSystem";

function issue(key: string): JiraIssue {
  return {
    key,
    summary: key,
    status: "To Do",
    description: "",
    parsed: { blockedBy: [], acceptanceCriteria: [] },
  };
}

function withStore<A>(
  run: Effect.Effect<A, unknown, StateStore>,
): Promise<A> {
  return runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectory({ prefix: "issue-dinner-" });
      return yield* run.pipe(Effect.provide(stateStoreLayer(dir, "strict")));
    }),
  );
}

describe("menuOrderBlocks", () => {
  it("blocks when a prior course is agent_complete", () =>
    withStore(
      Effect.gen(function* () {
        const store = yield* StateStore;
        yield* store.upsert({
          issueKey: "CPD-637",
          summary: "a",
          status: "agent_complete",
        });
        const menu = [issue("CPD-637"), issue("CPD-638")];
        const gate = yield* menuOrderBlocks(menu, 1, new Set());
        assert.equal(gate.ok, false);
        assert.match(gate.reason ?? "", /CPD-637/);
      }),
    ));

  it("allows next course when prior is verified", () =>
    withStore(
      Effect.gen(function* () {
        const store = yield* StateStore;
        yield* store.upsert({
          issueKey: "CPD-637",
          summary: "a",
          status: "verified",
        });
        const menu = [issue("CPD-637"), issue("CPD-638")];
        assert.equal(
          (yield* menuOrderBlocks(menu, 1, new Set())).ok,
          true,
        );
      }),
    ));
});
