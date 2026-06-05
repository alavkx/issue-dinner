import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  agentDeclinedHeal,
  buildHealPrompt,
  buildHealTypecheckPrompt,
  buildPostHealStoryResumePrompt,
  HEAL_DECLINE_MARKER,
} from "./heal-prompt.js";

describe("heal-prompt", () => {
  it("detects heal decline marker", () => {
    assert.equal(agentDeclinedHeal(`Nothing to do\n${HEAL_DECLINE_MARKER}`), true);
    assert.equal(agentDeclinedHeal("fixed src/cli.ts"), false);
  });

  it("builds typecheck feedback prompt", () => {
    const prompt = buildHealTypecheckPrompt({
      errors: "src/foo.ts(1,1): error TS1005",
      iteration: 2,
      maxIterations: 8,
    });
    assert.match(prompt, /typecheck feedback \(2\/8\)/);
    assert.match(prompt, /TS1005/);
  });

  it("includes inline trigger in dedicated heal prompt", () => {
    const prompt = buildHealPrompt({
      issue: {
        key: "CPD-636",
        summary: "Replay events",
        status: "Open",
        description: "",
        parsed: { acceptanceCriteria: [], blockedBy: [] },
      },
      toolRoot: "/tmp/issue-dinner",
      trigger: "inline",
      detail: "typecheck failed",
      attempt: 1,
      maxAttempts: 3,
    });
    assert.match(prompt, /inline validation failed/i);
  });

  it("builds post-heal story resume prompt without old errors", () => {
    const prompt = buildPostHealStoryResumePrompt({
      issue: {
        key: "CPD-636",
        summary: "Replay events",
        status: "Open",
        description: "",
        parsed: { acceptanceCriteria: [], blockedBy: [] },
      },
      fixSummary: "Fixed verify runner path resolution.",
    });
    assert.match(prompt, /issue-dinner was fixed/);
    assert.match(prompt, /do not retry or debug that old error/i);
    assert.match(prompt, /CPD-636/);
  });
});
