import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildAgentPrompt } from "./prompt.js";

describe("buildAgentPrompt", () => {
  it("includes vertical-slice TDD workflow and structured handoff sections", () => {
    const prompt = buildAgentPrompt({
      issue: {
        key: "CPD-636",
        summary: "Replayable GET /events",
        status: "Open",
        description: "## What to build\nDo the thing.",
        parsed: {
          acceptanceCriteria: ["GET /events accepts after_sequence"],
          blockedBy: [],
        },
      },
      cwd: "/tmp/fileservice2",
      workspaceKey: "backend",
    });

    assert.match(prompt, /Tracer bullet/i);
    assert.match(prompt, /RED.*GREEN/is);
    assert.match(prompt, /## Status/);
    assert.match(prompt, /## Verification/);
    assert.match(prompt, /public interface/i);
  });
});
