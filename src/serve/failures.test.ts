import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { issueFailed, primaryFailureMessage } from "./failures.js";
import type { IssueRunRecord } from "../state/store.js";

describe("issueFailed", () => {
  it("treats agent_complete as failed", () => {
    const rec: IssueRunRecord = {
      issueKey: "CPD-637",
      summary: "x",
      status: "agent_complete",
      verifyError: "Verify failed: events-backend",
    };
    assert.equal(issueFailed(rec), true);
    assert.match(primaryFailureMessage(rec), /events-backend/);
  });

  it("treats pending with stack prep resolution as failed", () => {
    const rec: IssueRunRecord = {
      issueKey: "CPD-638",
      summary: "x",
      status: "pending",
      resolutionSteps: [
        "Stack prep failed: working tree is dirty",
        "Recovery handoff not acceptable (status=unknown)",
      ],
    };
    assert.equal(issueFailed(rec), true);
    assert.match(primaryFailureMessage(rec), /dirty/);
  });

  it("verified is not failed", () => {
    const rec: IssueRunRecord = {
      issueKey: "CPD-636",
      summary: "x",
      status: "verified",
    };
    assert.equal(issueFailed(rec), false);
  });
});
