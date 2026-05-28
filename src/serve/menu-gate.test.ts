import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { JiraIssue } from "../jira/acli.js";
import { StateStore } from "../state/store.js";
import { menuOrderBlocks } from "./menu-gate.js";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

function issue(key: string): JiraIssue {
  return {
    key,
    summary: key,
    status: "To Do",
    description: "",
    parsed: { blockedBy: [], acceptanceCriteria: [] },
  };
}

describe("menuOrderBlocks", () => {
  it("blocks when a prior course is agent_complete", () => {
    const dir = mkdtempSync(join(tmpdir(), "issue-dinner-"));
    try {
      const store = new StateStore(dir, "strict");
      store.upsert({
        issueKey: "CPD-637",
        summary: "a",
        status: "agent_complete",
      });
      const menu = [issue("CPD-637"), issue("CPD-638")];
      const gate = menuOrderBlocks(store, menu, 1, new Set());
      assert.equal(gate.ok, false);
      assert.match(gate.reason ?? "", /CPD-637/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("allows next course when prior is verified", () => {
    const dir = mkdtempSync(join(tmpdir(), "issue-dinner-"));
    try {
      const store = new StateStore(dir, "strict");
      store.upsert({
        issueKey: "CPD-637",
        summary: "a",
        status: "verified",
      });
      const menu = [issue("CPD-637"), issue("CPD-638")];
      assert.equal(menuOrderBlocks(store, menu, 1, new Set()).ok, true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
