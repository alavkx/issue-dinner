import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { DinnerConfig } from "../config.js";
import { resolveVerifyCommands } from "./resolve.js";

const base: DinnerConfig = {
  model: "composer-2.5",
  workspaces: { backend: "/tmp/be" },
  defaultWorkspace: "backend",
  settingSources: ["project"],
  requireVerify: true,
  requireHandoffTests: true,
  exclude: [],
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
    const cmds = resolveVerifyCommands(config, "CPD-636", "backend");
    assert.equal(cmds[0]?.name, "specific");
  });
});
