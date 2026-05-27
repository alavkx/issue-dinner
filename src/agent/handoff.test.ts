import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  agentPhaseSucceeded,
  parseHandoff,
  verificationIsStrongEnough,
} from "./handoff.js";

describe("parseHandoff", () => {
  it("extracts status and verification from orchestrate-style handoff", () => {
    const text = `## Status
success

## Verification
unit-test-verified

## Measurements
- pytest fileservice2/v3/events: 12 passing → 14 passing

## What I did
- Wired after_sequence on GET /events
`;

    const h = parseHandoff(text);
    assert.equal(h.status, "success");
    assert.equal(h.verification, "unit-test-verified");
    assert.match(h.measurements ?? "", /pytest/);
  });

  it("returns unknown status when handoff sections are missing", () => {
    const h = parseHandoff("Implemented the feature. All good!");
    assert.equal(h.status, "unknown");
    assert.equal(h.verification, "not-verified");
  });
});

describe("agentPhaseSucceeded", () => {
  it("accepts success and partial status", () => {
    assert.equal(agentPhaseSucceeded({ status: "success" }), true);
    assert.equal(agentPhaseSucceeded({ status: "partial" }), true);
    assert.equal(agentPhaseSucceeded({ status: "blocked" }), false);
    assert.equal(agentPhaseSucceeded({ status: "unknown" }), false);
  });
});

describe("verificationIsStrongEnough", () => {
  it("rejects not-verified and type-check-only for slices that require tests", () => {
    assert.equal(
      verificationIsStrongEnough("unit-test-verified", { requireTests: true }),
      true,
    );
    assert.equal(
      verificationIsStrongEnough("live-ui-verified", { requireTests: true }),
      true,
    );
    assert.equal(
      verificationIsStrongEnough("type-check-only", { requireTests: true }),
      false,
    );
    assert.equal(
      verificationIsStrongEnough("not-verified", { requireTests: true }),
      false,
    );
  });
});
