import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildAgentPrompt } from "./prompt.js";
import type { MachineConfig } from "../config.js";

const config: MachineConfig = {
  model: "composer-2.5",
  workspaces: { backend: "/tmp/fileservice2" },
  defaultWorkspace: "backend",
  settingSources: ["project"],
  requireVerify: true,
  serveVerifyGate: "inner",
  requireHandoffTests: true,
  graphiteTrunk: "main",
  blockerPolicy: "strict" as const,
  commitWip: true,
  recoveryAttempts: 2,
  quietRecovery: true,
};

describe("buildAgentPrompt kitchen section", () => {
  it("documents the kitchen inbox when self-heal is enabled", () => {
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
        keys: ["backend"],
        cwds: ["/tmp/fileservice2"],
      },
      config,
      verifyCommands: [],
      selfHeal: true,
      kitchenRoot: "/tmp/issue-dinner",
    });

    assert.match(prompt, /Kitchen \(issue-dinner self-heal — on by default\)/);
    assert.match(prompt, /manifest\.json/);
    assert.match(prompt, /\/tmp\/issue-dinner/);
  });
});
