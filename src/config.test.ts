import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as Schema from "effect/Schema";
import { MachineConfigSchema } from "./config.js";

const decode = Schema.decodeUnknownSync(MachineConfigSchema);

describe("MachineConfigSchema", () => {
  it("applies defaults for omitted fields", () => {
    const config = decode({
      workspaces: { backend: "/tmp/backend" },
      defaultWorkspace: "backend",
    });
    assert.equal(config.model, "composer-2.5");
    assert.equal(config.serveVerifyGate, "inner");
    assert.equal(config.recoveryAttempts, 2);
    assert.deepEqual(config.settingSources, ["project"]);
    assert.equal(config.graphiteTrunk, "main");
  });

  it("parses verify command tiers", () => {
    const config = decode({
      workspaces: { backend: "/tmp/backend" },
      defaultWorkspace: "backend",
      verifyCommands: {
        backend: [
          {
            name: "unit",
            tier: "inner",
            command: "npm",
            args: ["test"],
          },
        ],
      },
    });
    assert.equal(config.verifyCommands?.backend?.[0]?.tier, "inner");
  });

  it("rejects recoveryAttempts above the configured max", () => {
    assert.throws(() =>
      decode({
        workspaces: { backend: "/tmp/backend" },
        defaultWorkspace: "backend",
        recoveryAttempts: 99,
      }),
    );
  });
});
