import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { DinnerConfig } from "../config.js";
import { resolveVerifyCommandsForIssue } from "./resolve.js";

const base: DinnerConfig = {
  model: "composer-2.5",
  workspaces: { backend: "/tmp/be", frontend: "/tmp/fe" },
  defaultWorkspace: "backend",
  settingSources: ["project"],
  requireVerify: true,
  requireHandoffTests: true,
  graphiteTrunk: "main",
};

describe("resolveVerifyCommands", () => {
  it("prefers per-issue commands over workspace defaults", () => {
    const config: DinnerConfig = {
      ...base,
      verifyCommands: {
        backend: [{ name: "default", command: "echo", args: ["workspace"] }],
      },
      issueVerifyCommands: {
        "CPD-636": [{ name: "specific", command: "echo", args: ["issue"] }],
      },
    };
    const cmds = resolveVerifyCommandsForIssue(config, "CPD-636", ["backend"]);
    assert.equal(cmds[0]?.name, "specific");
    assert.equal(cmds[0]?.cwd, "/tmp/be");
  });

  it("runs verifyCommands for each workspace root in a multi-root issue", () => {
    const config: DinnerConfig = {
      ...base,
      verifyCommands: {
        backend: [{ name: "be-test", command: "echo", args: ["be"] }],
        frontend: [{ name: "fe-test", command: "echo", args: ["fe"] }],
      },
    };
    const cmds = resolveVerifyCommandsForIssue(config, "CPD-636", [
      "backend",
      "frontend",
    ]);
    assert.equal(cmds.length, 2);
    assert.equal(cmds[0]?.cwd, "/tmp/be");
    assert.equal(cmds[1]?.cwd, "/tmp/fe");
  });
});
