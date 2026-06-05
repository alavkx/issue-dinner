import assert from "node:assert/strict";
import * as Effect from "effect/Effect";
import { describe, it } from "node:test";
import type { MachineConfig } from "../config.js";
import type { JiraIssue } from "../jira/acli.js";
import { runEffect } from "../effect/test-runtime.js";
import type { GraphiteStackPort } from "./graphite-port.js";
import { checkoutIssueStack, prepEpicStack } from "./prep.js";

const config: MachineConfig = {
  model: "composer-2.5",
  workspaces: { backend: "/tmp/backend" },
  defaultWorkspace: "backend",
  issueWorkspace: { "CPD-637": "backend" },
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

const stack = {
  base: "dev/proj-100-trunk",
  prefix: "dev/proj-100",
  graphiteTrunk: "main",
};

function issue(key: string, blockedBy: string[] = []): JiraIssue {
  return {
    key,
    summary: "",
    status: "To Do",
    description: "",
    parsed: { blockedBy, acceptanceCriteria: [] },
  };
}

function recordingPort(): GraphiteStackPort & {
  calls: Array<{ op: string; cwd: string; detail: string }>;
} {
  const calls: Array<{ op: string; cwd: string; detail: string }> = [];
  const port: GraphiteStackPort & {
    calls: typeof calls;
  } = {
    calls,
    branchExists: (_cwd, branch) =>
      Effect.succeed(branch === "dev/proj-100-trunk"),
    currentBranch: () => Effect.succeed("dev/proj-100-trunk"),
    isWorkingTreeClean: () => Effect.succeed(true),
    checkoutBranch: (cwd, branch) =>
      Effect.sync(() => {
        calls.push({ op: "checkout", cwd, detail: branch });
      }),
    trackBranch: (cwd, branch, parent) =>
      Effect.sync(() => {
        calls.push({ op: "track", cwd, detail: `${branch}<-${parent}` });
      }),
    createStackedBranch: (cwd, branch, parent) =>
      Effect.sync(() => {
        calls.push({ op: "create", cwd, detail: `${branch}<-${parent}` });
      }),
  };
  return port;
}

describe("prepEpicStack", () => {
  it("creates story branches in dependency order for each workspace", () =>
    runEffect(
      Effect.gen(function* () {
        const port = recordingPort();
        const issues = [issue("CPD-637"), issue("CPD-636")];

        const summary = yield* prepEpicStack(issues, config, stack, port);

        assert.equal(summary.length, 2);
        assert.equal(summary[0]?.action, "create");
        assert.match(summary[1]?.branch ?? "", /cpd-637/);
      }),
    ));

  it("tracks an existing stack base before creating story branches", () =>
    runEffect(
      Effect.gen(function* () {
        const port = recordingPort();
        yield* prepEpicStack([issue("CPD-636")], config, stack, port);

        const track = port.calls.find((c) => c.op === "track");
        assert.ok(track);
        assert.equal(track?.detail, "dev/proj-100-trunk<-main");
      }),
    ));
});

describe("checkoutIssueStack", () => {
  it("checks out only workspaces that participate in the issue", () =>
    runEffect(
      Effect.gen(function* () {
        const port = recordingPort();
        const multiConfig: MachineConfig = {
          ...config,
          issueWorkspaces: { "CPD-636": ["backend", "frontend"] },
          workspaces: {
            backend: "/tmp/backend",
            frontend: "/tmp/frontend",
          },
        };

        yield* checkoutIssueStack(issue("CPD-636"), multiConfig, stack, port);

        const backend = port.calls.filter((c) => c.cwd === "/tmp/backend");
        const frontend = port.calls.filter((c) => c.cwd === "/tmp/frontend");
        assert.ok(backend.length > 0);
        assert.ok(frontend.length > 0);
      }),
    ));
});
