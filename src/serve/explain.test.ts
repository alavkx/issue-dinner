import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { explainCourseFailure, explainPreflightFailure } from "./explain.js";

describe("explainPreflightFailure", () => {
  it("explains missing inner verify for CPD-638", () => {
    const e = explainPreflightFailure(
      "CPD-638: verify: no commands configured",
      "Add issueVerifyCommands",
      "CPD-638",
    );
    assert.match(e.summary, /quick|skip|continue/i);
    assert.ok(!e.steps.some((s) => s.includes("config.json")));
    assert.ok(e.steps.some((s) => s.includes("issue-dinner verify")));
  });
});

describe("explainCourseFailure", () => {
  it("explains dirty tree in plain language", () => {
    const e = explainCourseFailure("CPD-638", "CPD-635", {
      issueKey: "CPD-638",
      summary: "Notifications",
      status: "pending",
      resolutionSteps: [
        "Stack prep failed: working tree is dirty — commit, stash, or clean",
      ],
    });
    assert.match(e.whatWentWrong, /uncommitted/i);
    assert.ok(e.whatToDo.length >= 1);
  });
});
