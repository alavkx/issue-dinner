import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  parseReviewDecision,
  REVIEW_APPROVE_MARKER,
  REVIEW_REJECT_MARKER,
} from "./review-agent.js";

describe("parseReviewDecision", () => {
  it("parses approve and reject lists", () => {
    const text = `
${REVIEW_APPROVE_MARKER}: heal-cpd-1, heal-cpd-2
${REVIEW_REJECT_MARKER}: heal-cpd-3
`;
    const decision = parseReviewDecision(text);
    assert.deepEqual(decision.approved, ["heal-cpd-1", "heal-cpd-2"]);
    assert.deepEqual(decision.rejected, ["heal-cpd-3"]);
  });

  it("handles reject all", () => {
    const decision = parseReviewDecision(`${REVIEW_REJECT_MARKER}: all`);
    assert.deepEqual(decision.rejected, ["__all__"]);
  });
});
