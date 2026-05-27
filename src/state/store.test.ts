import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { StateStore } from "./store.js";

describe("StateStore.isDone", () => {
  it("treats only verified and skipped as done for blocker gating", () => {
    const dir = mkdtempSync(join(tmpdir(), "issue-dinner-"));
    try {
      const store = new StateStore(dir);
      store.upsert({
        issueKey: "CPD-636",
        summary: "x",
        status: "agent_complete",
      });
      assert.equal(store.isDone("CPD-636"), false);

      store.upsert({
        issueKey: "CPD-636",
        summary: "x",
        status: "verified",
      });
      assert.equal(store.isDone("CPD-636"), true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
