import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { IssueRunRecord } from "../state/store.js";
import {
  countRecoveryAttempts,
  extractHandoffExcerpt,
  extractManualVerificationItems,
  formatDuration,
  formatKeyList,
  wasRecovered,
} from "./summary-helpers.js";

describe("summary helpers", () => {
  it("counts recovery attempt lines", () => {
    assert.equal(
      countRecoveryAttempts([
        "Recovery verify attempt 1/2",
        "Recovery run error: error",
        "Recovery verify attempt 2/2",
      ]),
      2,
    );
  });

  it("detects recovered verified courses", () => {
    const rec: IssueRunRecord = {
      issueKey: "CPD-641",
      summary: "x",
      status: "verified",
      resolutionSteps: [
        "Commit failed: frontend",
        "Recovery commit attempt 1/2",
      ],
    };
    assert.equal(wasRecovered(rec), true);
  });

  it("extracts first measurement bullet from handoff preview", () => {
    const preview = `## Status
success

## Measurements
- jobs-collection event-sync tests: 0 → 3 passing
- Typecheck: pass`;

    assert.equal(
      extractHandoffExcerpt(preview),
      "jobs-collection event-sync tests: 0 → 3 passing",
    );
  });

  it("extracts unchecked acceptance criteria", () => {
    const preview = `## Acceptance criteria (checklist)
1. [x] wired collection
2. [ ] Manual smoke in dev environment`;

    assert.deepEqual(extractManualVerificationItems(preview), [
      "Manual smoke in dev environment",
    ]);
  });

  it("formats duration and key lists", () => {
    const start = new Date(Date.now() - 90 * 60_000).toISOString();
    assert.equal(formatDuration(start), "1h 30m");
    assert.equal(formatKeyList(["A", "B", "C", "D", "E"]), "A, B, C +2 more");
  });
});
