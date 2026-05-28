import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { MachineConfig } from "../config.js";
import {
  localAgentOptions,
  resolveIssueWorkspaces,
  sdkCwd,
} from "./workspaces.js";

const base: MachineConfig = {
  model: "composer-2.5",
  workspaces: {
    backend: "/tmp/fileservice2",
    frontend: "/tmp/istari-frontend",
    schemas: "/tmp/api-schemas",
    sdk: "/tmp/istari-ts-client",
  },
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
};

describe("resolveIssueWorkspaces", () => {
  it("uses issueWorkspaces when configured", () => {
    const config: MachineConfig = {
      ...base,
      issueWorkspaces: {
        "CPD-636": ["backend", "schemas", "sdk", "frontend"],
      },
    };
    const roots = resolveIssueWorkspaces(
      config,
      "CPD-636",
      "",
      "Replayable GET /events",
    );
    assert.deepEqual(roots.keys, ["backend", "schemas", "sdk", "frontend"]);
    assert.equal(roots.primaryKey, "backend");
    assert.deepEqual(roots.cwds, [
      "/tmp/fileservice2",
      "/tmp/api-schemas",
      "/tmp/istari-ts-client",
      "/tmp/istari-frontend",
    ]);
  });

  it("falls back to a single workspace from issueWorkspace", () => {
    const config: MachineConfig = {
      ...base,
      issueWorkspace: { "CPD-639": "frontend" },
    };
    const roots = resolveIssueWorkspaces(config, "CPD-639", "", "Client poll");
    assert.deepEqual(roots.keys, ["frontend"]);
    assert.equal(roots.cwds.length, 1);
  });
});

describe("sdkCwd", () => {
  it("returns a string for one root and an array for several", () => {
    assert.equal(sdkCwd(["/a"]), "/a");
    assert.deepEqual(sdkCwd(["/a", "/b"]), ["/a", "/b"]);
  });
});

describe("localAgentOptions", () => {
  it("passes multi-root cwd to match Cursor SDK local agent shape", () => {
    const opts = localAgentOptions(base, ["/a", "/b"]);
    assert.deepEqual(opts.cwd, ["/a", "/b"]);
    assert.deepEqual(opts.settingSources, ["project"]);
  });
});
