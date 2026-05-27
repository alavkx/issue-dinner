import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ensureStackStep, type GraphiteStackPort } from "./graphite-port.js";

function mockPort(overrides: Partial<GraphiteStackPort>): GraphiteStackPort {
  return {
    branchExists: async () => false,
    currentBranch: async () => "main",
    isWorkingTreeClean: async () => true,
    checkoutBranch: async () => {},
    trackBranch: async () => {},
    createStackedBranch: async () => {},
    ...overrides,
  };
}

describe("ensureStackStep", () => {
  it("is a no-op when already on the story branch", async () => {
    const port = mockPort({
      currentBranch: async () => "alavoie/cpd-635/cpd-636",
    });
    const result = await ensureStackStep(
      "/repo",
      {
        issueKey: "CPD-636",
        branch: "alavoie/cpd-635/cpd-636",
        parent: "alavoie/cpd-635-user-event-log",
      },
      port,
    );
    assert.equal(result.action, "noop");
  });

  it("checks out an existing story branch", async () => {
    let checkedOut = "";
    const port = mockPort({
      branchExists: async () => true,
      checkoutBranch: async (_cwd, branch) => {
        checkedOut = branch;
      },
    });
    const result = await ensureStackStep(
      "/repo",
      {
        issueKey: "CPD-636",
        branch: "alavoie/cpd-635/cpd-636",
        parent: "alavoie/cpd-635-user-event-log",
      },
      port,
    );
    assert.equal(result.action, "checkout");
    assert.equal(checkedOut, "alavoie/cpd-635/cpd-636");
  });

  it("creates a stacked branch when missing", async () => {
    let created: { branch: string; parent: string } | undefined;
    const port = mockPort({
      createStackedBranch: async (_cwd, branch, parent) => {
        created = { branch, parent };
      },
    });
    const result = await ensureStackStep(
      "/repo",
      {
        issueKey: "CPD-636",
        branch: "alavoie/cpd-635/cpd-636",
        parent: "alavoie/cpd-635-user-event-log",
      },
      port,
    );
    assert.equal(result.action, "create");
    assert.deepEqual(created, {
      branch: "alavoie/cpd-635/cpd-636",
      parent: "alavoie/cpd-635-user-event-log",
    });
  });

  it("refuses to switch branches with a dirty working tree", async () => {
    const port = mockPort({ isWorkingTreeClean: async () => false });
    await assert.rejects(
      () =>
        ensureStackStep(
          "/repo",
          {
            issueKey: "CPD-636",
            branch: "alavoie/cpd-635/cpd-636",
            parent: "alavoie/cpd-635-user-event-log",
          },
          port,
        ),
      /dirty/,
    );
  });
});
