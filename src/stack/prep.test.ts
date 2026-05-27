import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { DinnerConfig } from "../config.js";
import type { JiraIssue } from "../jira/acli.js";
import type { GraphiteStackPort } from "./graphite-port.js";
import { checkoutIssueStack, prepEpicStack } from "./prep.js";

const config: DinnerConfig = {
  model: "composer-2.5",
  workspaces: { backend: "/tmp/backend" },
  defaultWorkspace: "backend",
  issueWorkspace: { "CPD-637": "backend" },
  settingSources: ["project"],
  requireVerify: true,
  requireHandoffTests: true,
  graphiteTrunk: "main",
  blockerPolicy: "strict" as const,
  commitWip: true,
};

const stack = {
  base: "alavoie/cpd-635-user-event-log",
  prefix: "alavoie/cpd-635",
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
    branchExists: async (_cwd, branch) =>
      branch === "alavoie/cpd-635-user-event-log",
    currentBranch: async () => "alavoie/cpd-635-user-event-log",
    isWorkingTreeClean: async () => true,
    checkoutBranch: async (cwd, branch) => {
      calls.push({ op: "checkout", cwd, detail: branch });
    },
    trackBranch: async (cwd, branch, parent) => {
      calls.push({ op: "track", cwd, detail: `${branch}<-${parent}` });
    },
    createStackedBranch: async (cwd, branch, parent) => {
      calls.push({ op: "create", cwd, detail: `${branch}<-${parent}` });
    },
  };
  return port;
}

describe("prepEpicStack", () => {
  it("creates story branches in dependency order for each workspace", async () => {
    const port = recordingPort();
    const issues = [issue("CPD-637"), issue("CPD-636")];

    const summary = await prepEpicStack(issues, config, stack, port);

    assert.equal(summary.length, 2);
    assert.equal(summary[0]?.action, "create");
    assert.match(summary[1]?.branch ?? "", /cpd-637/);
  });

  it("tracks an existing stack base before creating story branches", async () => {
    const port = recordingPort();
    await prepEpicStack([issue("CPD-636")], config, stack, port);

    const track = port.calls.find((c) => c.op === "track");
    assert.ok(track);
    assert.equal(
      track?.detail,
      "alavoie/cpd-635-user-event-log<-main",
    );
  });
});

describe("checkoutIssueStack", () => {
  it("checks out only workspaces that participate in the issue", async () => {
    const port = recordingPort();
    const multiConfig: DinnerConfig = {
      ...config,
      issueWorkspaces: { "CPD-636": ["backend", "frontend"] },
      workspaces: {
        backend: "/tmp/backend",
        frontend: "/tmp/frontend",
      },
    };

    await checkoutIssueStack(issue("CPD-636"), multiConfig, stack, port);

    const backend = port.calls.filter((c) => c.cwd === "/tmp/backend");
    const frontend = port.calls.filter((c) => c.cwd === "/tmp/frontend");
    assert.ok(backend.length > 0);
    assert.ok(frontend.length > 0);
  });
});
