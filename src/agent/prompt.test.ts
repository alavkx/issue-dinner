import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { DinnerConfig } from "../config.js";
import { buildAgentPrompt } from "./prompt.js";

const config: DinnerConfig = {
  model: "composer-2.5",
  workspaces: { backend: "/tmp/fileservice2" },
  defaultWorkspace: "backend",
  settingSources: ["project"],
  requireVerify: true,
  requireHandoffTests: true,
  graphiteTrunk: "main",
  blockerPolicy: "strict" as const,
  commitWip: true,
  issueVerifyCommands: {
    "CPD-636": [
      {
        name: "events-unit",
        command: "poetry",
        args: ["run", "pytest", "tests/v3/unit_test/events/", "-q"],
      },
    ],
  },
};

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
      config,
    });

    assert.match(prompt, /tracer bullets/i);
    assert.match(prompt, /RED:.*GREEN:/is);
    assert.match(prompt, /## Status/);
    assert.match(prompt, /## Verification/);
    assert.match(prompt, /Verify gate/);
    assert.match(prompt, /tests\/v3\/unit_test\/events/);
    assert.match(prompt, /public interface/i);
    assert.match(prompt, /local/i);
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
      config,
    });

    assert.match(prompt, /Multi-root workspace/i);
    assert.match(prompt, /\/tmp\/be/);
    assert.match(prompt, /\/tmp\/schemas/);
    assert.match(prompt, /\/tmp\/sdk/);
    assert.match(prompt, /not cloud/i);
  });
});
