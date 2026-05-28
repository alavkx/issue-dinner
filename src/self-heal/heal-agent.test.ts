import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Effect } from "effect";
import { runEffect } from "../effect/test-runtime.js";
import { attemptSelfHealFromCourse } from "./heal-agent.js";

describe("attemptSelfHealFromCourse", () => {
  it("skips when serve context is missing", async () => {
    const result = await runEffect(
      attemptSelfHealFromCourse({
        issue: {
          key: "CPD-1",
          summary: "test",
          status: "Open",
          description: "",
          parsed: { acceptanceCriteria: [], blockedBy: [] },
        },
        config: {
          model: "composer-2.5",
          workspaces: { backend: "/tmp" },
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
        },
        apiKey: "test-key",
        selfHeal: true,
        kitchenRoot: "/tmp/issue-dinner",
        trigger: "orchestration",
        detail: "boom",
      }),
    );
    assert.equal(result, undefined);
  });
});
