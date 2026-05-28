import assert from "node:assert/strict";
import * as Effect from "effect/Effect";
import { describe, it } from "node:test";
import type { MachineConfig } from "../config.js";
import { runEffect } from "../effect/test-runtime.js";
import { validateVerifyCommands } from "./validate.js";

const config: MachineConfig = {
  model: "composer-2.5",
  workspaces: { backend: "/tmp/nope" },
  defaultWorkspace: "backend",
  settingSources: ["project"],
  requireVerify: true,
  serveVerifyGate: "inner",
  requireHandoffTests: true,
  graphiteTrunk: "main",
  blockerPolicy: "strict" as const,
  commitWip: true,
  recoveryAttempts: 2,
  healAttempts: 3,
  healTypecheckIterations: 8,
  quietRecovery: true,
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
  it("flags missing test paths", () =>
    runEffect(
      Effect.gen(function* () {
        const results = yield* validateVerifyCommands(
          config,
          "CPD-636",
          ["backend"],
        );
        const missing = results.find((r) => r.message.includes("missing"));
        assert.ok(missing);
        assert.equal(missing?.ok, false);
        assert.ok(missing?.fix);
      }),
    ));
});
