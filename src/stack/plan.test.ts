import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { MachineConfig } from "../config.js";
import type { JiraIssue } from "../jira/acli.js";
import { buildRepoStackPlan } from "./plan.js";

const baseConfig: MachineConfig = {
  model: "composer-2.5",
  workspaces: {
    backend: "/tmp/backend",
    frontend: "/tmp/frontend",
  },
  defaultWorkspace: "backend",
  issueWorkspace: {
    "CPD-637": "backend",
    "CPD-639": "frontend",
    "CPD-641": "frontend",
  },
  issueWorkspaces: {
    "CPD-636": ["backend", "frontend"],
  },
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
};

function issue(
  key: string,
  blockedBy: string[] = [],
  workspaceHint = "",
): JiraIssue {
  return {
    key,
    summary: workspaceHint,
    status: "To Do",
    description: "",
    parsed: { blockedBy, acceptanceCriteria: [] },
  };
}

describe("buildRepoStackPlan", () => {
  it("orders story branches by Jira blockers within one repo", () => {
    const issues = [
      issue("CPD-641", ["CPD-637", "CPD-639"]),
      issue("CPD-639", ["CPD-636"]),
      issue("CPD-636"),
      issue("CPD-637"),
    ];

    const plan = buildRepoStackPlan(
      issues,
      baseConfig,
      "frontend",
      "dev/proj-100-trunk",
      "dev/proj-100",
    );

    assert.deepEqual(
      plan.map((s) => s.issueKey),
      ["CPD-636", "CPD-639", "CPD-641"],
    );
    assert.deepEqual(plan[0], {
      issueKey: "CPD-636",
      branch: "dev/proj-100/cpd-636",
      parent: "dev/proj-100-trunk",
    });
    assert.equal(plan[1]?.parent, "dev/proj-100/cpd-636");
    assert.equal(plan[2]?.parent, "dev/proj-100/cpd-639");
  });

  it("omits issues that do not touch the workspace", () => {
    const splitConfig: MachineConfig = {
      ...baseConfig,
      issueWorkspaces: { "CPD-636": ["frontend"] },
    };
    const issues = [issue("CPD-637"), issue("CPD-636")];

    const backendPlan = buildRepoStackPlan(
      issues,
      splitConfig,
      "backend",
      "dev/proj-100-trunk",
      "dev/proj-100",
    );

    const frontendPlan = buildRepoStackPlan(
      issues,
      splitConfig,
      "frontend",
      "dev/proj-100-trunk",
      "dev/proj-100",
    );

    assert.deepEqual(
      backendPlan.map((s) => s.issueKey),
      ["CPD-637"],
    );
    assert.deepEqual(
      frontendPlan.map((s) => s.issueKey),
      ["CPD-636"],
    );
  });
});
