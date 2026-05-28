import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { courseAgentOptions, healAgentOptions } from "../config/workspaces.js";
import type { MachineConfig } from "../config.js";

const config: MachineConfig = {
  model: "composer-2.5",
  workspaces: { backend: "/tmp/backend" },
  defaultWorkspace: "backend",
  settingSources: ["project"],
  requireVerify: true,
  serveVerifyGate: "inner",
  requireHandoffTests: true,
  graphiteTrunk: "main",
  blockerPolicy: "strict",
  commitWip: true,
  recoveryAttempts: 2,
  healAttempts: 3,
  healTypecheckIterations: 8,
  quietRecovery: true,
};

describe("agent workspace options", () => {
  it("includes kitchen root in course agent cwd when self-heal is on", () => {
    const opts = courseAgentOptions(
      config,
      { primaryKey: "backend", keys: ["backend"], cwds: ["/tmp/backend"] },
      "/tmp/issue-dinner",
    );
    assert.deepEqual(opts.cwd, ["/tmp/issue-dinner", "/tmp/backend"]);
  });

  it("heal agent uses kitchen root only", () => {
    const opts = healAgentOptions(config, "/tmp/issue-dinner");
    assert.equal(opts.cwd, "/tmp/issue-dinner");
  });
});
