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

  it("treats agent_complete as done when blockerPolicy is agent_complete", () => {
    const dir = mkdtempSync(join(tmpdir(), "issue-dinner-"));
    try {
      const store = new StateStore(dir, "agent_complete");
      store.upsert({
        issueKey: "CPD-636",
        summary: "x",
        status: "agent_complete",
      });
      assert.equal(store.isDone("CPD-636"), true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("appendResolutionStep accumulates steps", () => {
    const dir = mkdtempSync(join(tmpdir(), "issue-dinner-"));
    try {
      const store = new StateStore(dir);
      store.setEpic("CPD-635");
      store.appendResolutionStep("CPD-637", "first");
      store.appendResolutionStep("CPD-637", "second");
      assert.deepEqual(store.get("CPD-637")?.resolutionSteps, [
        "first",
        "second",
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("recovers stale running records", () => {
    const dir = mkdtempSync(join(tmpdir(), "issue-dinner-"));
    try {
      const store = new StateStore(dir);
      store.upsert({
        issueKey: "CPD-636",
        summary: "x",
        status: "running",
      });
      const recovered = store.recoverStaleRunning();
      assert.deepEqual(recovered, ["CPD-636"]);
      assert.equal(store.get("CPD-636")?.status, "error");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
