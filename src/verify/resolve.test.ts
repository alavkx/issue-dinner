import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it } from "node:test";
import * as Effect from "effect/Effect";
import type { MachineConfig } from "../config.js";
import { runEffect } from "../effect/test-runtime.js";
import { resolveVerifyCommandsForIssue } from "./resolve.js";
import { effectiveVerifyTier } from "./tier.js";

const base: MachineConfig = {
  model: "composer-2.5",
  workspaces: { backend: "/tmp/be", frontend: "/tmp/fe" },
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

describe("resolveVerifyCommandsForIssue", () => {
  it("prefers per-issue commands over workspace defaults", () =>
    runEffect(
      resolveVerifyCommandsForIssue(configWithIssueOverride(), "CPD-636", [
        "backend",
      ]).pipe(
        Effect.tap((cmds) => {
          assert.equal(cmds[0]?.name, "specific");
          assert.equal(cmds[0]?.cwd, "/tmp/be");
        }),
        Effect.asVoid,
      ),
    ));

  it("runs verifyCommands for each workspace root in a multi-root issue", () =>
    runEffect(
      resolveVerifyCommandsForIssue(configWithWorkspaceDefaults(), "CPD-636", [
        "backend",
        "frontend",
      ]).pipe(
        Effect.tap((cmds) => {
          assert.equal(cmds.length, 2);
          assert.equal(cmds[0]?.cwd, "/tmp/be");
          assert.equal(cmds[1]?.cwd, "/tmp/fe");
        }),
        Effect.asVoid,
      ),
    ));

  it("infers inner unit tests from outer-only issue commands", () => {
    const cwd = mkdtempSync(join(tmpdir(), "issue-dinner-resolve-"));
    const unitDir = join(cwd, "tests/v3/unit_test");
    const intDir = join(cwd, "tests/v3/integration");
    mkdirSync(unitDir, { recursive: true });
    mkdirSync(intDir, { recursive: true });
    writeFileSync(join(unitDir, "test_notification_service.py"), "");
    writeFileSync(join(intDir, "test_notification_routes.py"), "");

    const config: MachineConfig = {
      ...base,
      workspaces: { backend: cwd },
      issueVerifyCommands: {
        "CPD-638": [
          {
            name: "notifications-integration",
            tier: "outer",
            command: "poetry",
            args: [
              "run",
              "pytest",
              "tests/v3/integration/test_notification_routes.py",
              "-q",
            ],
            workspace: "backend",
          },
        ],
      },
    };

    return runEffect(
      resolveVerifyCommandsForIssue(config, "CPD-638", ["backend"]).pipe(
        Effect.tap((cmds) => {
          const inner = cmds.filter((c) => effectiveVerifyTier(c) === "inner");
          assert.ok(inner.length >= 1);
          assert.ok(
            inner.some((c) => c.args.some((a) => a.includes("unit_test"))),
          );
        }),
        Effect.asVoid,
      ),
    );
  });
});

function configWithIssueOverride(): MachineConfig {
  return {
    ...base,
    verifyCommands: {
      backend: [{ name: "default", command: "echo", args: ["workspace"] }],
    },
    issueVerifyCommands: {
      "CPD-636": [{ name: "specific", command: "echo", args: ["issue"] }],
    },
  };
}

function configWithWorkspaceDefaults(): MachineConfig {
  return {
    ...base,
    verifyCommands: {
      backend: [{ name: "be-test", command: "echo", args: ["be"] }],
      frontend: [{ name: "fe-test", command: "echo", args: ["fe"] }],
    },
  };
}
