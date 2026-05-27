import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { DinnerConfig } from "../config.js";
import { validateVerifyCommands } from "./validate.js";

const config: DinnerConfig = {
  model: "composer-2.5",
  workspaces: { backend: "/tmp/nope" },
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
        workspace: "backend",
      },
    ],
  },
};

describe("validateVerifyCommands", () => {
  it("flags missing test paths", () => {
    const results = validateVerifyCommands(config, "CPD-636", ["backend"]);
    const missing = results.find((r) => r.message.includes("missing"));
    assert.ok(missing);
    assert.equal(missing?.ok, false);
    assert.ok(missing?.fix);
  });
});
