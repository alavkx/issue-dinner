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
      roots: {
        primaryKey: "backend",
        keys: ["backend"],
        cwds: ["/tmp/fileservice2"],
      },
    });

    assert.match(prompt, /Tracer bullet/i);
    assert.match(prompt, /RED.*GREEN/is);
    assert.match(prompt, /## Status/);
    assert.match(prompt, /## Verification/);
    assert.match(prompt, /public interface/i);
  });

  it("lists every multi-root cwd for the agent", () => {
    const prompt = buildAgentPrompt({
      issue: {
        key: "CPD-636",
        summary: "Replayable GET /events",
        status: "Open",
        description: "",
        parsed: { acceptanceCriteria: [], blockedBy: [] },
      },
      roots: {
        primaryKey: "backend",
        keys: ["backend", "schemas", "sdk"],
        cwds: ["/tmp/be", "/tmp/schemas", "/tmp/sdk"],
      },
    });

    assert.match(prompt, /Multi-root workspace/i);
    assert.match(prompt, /\/tmp\/be/);
    assert.match(prompt, /\/tmp\/schemas/);
    assert.match(prompt, /\/tmp\/sdk/);
  });
});
