import assert from "node:assert/strict";
import * as Effect from "effect/Effect";
import { describe, it } from "node:test";
import { runEffect } from "../effect/test-runtime.js";
import { ensureStackStep, type GraphiteStackPort } from "./graphite-port.js";

function mockPort(overrides: Partial<GraphiteStackPort>): GraphiteStackPort {
  return {
    branchExists: () => Effect.succeed(false),
    currentBranch: () => Effect.succeed("main"),
    isWorkingTreeClean: () => Effect.succeed(true),
    checkoutBranch: () => Effect.void,
    trackBranch: () => Effect.void,
    createStackedBranch: () => Effect.void,
    ...overrides,
  };
}

describe("ensureStackStep", () => {
  it("is a no-op when already on the story branch", () =>
    runEffect(
      Effect.gen(function* () {
        const port = mockPort({
          currentBranch: () => Effect.succeed("alavoie/cpd-635/cpd-636"),
        });
        const result = yield* ensureStackStep(
          "/repo",
          {
            issueKey: "CPD-636",
            branch: "alavoie/cpd-635/cpd-636",
            parent: "alavoie/cpd-635-user-event-log",
          },
          port,
        );
        assert.equal(result.action, "noop");
      }),
    ));

  it("checks out an existing story branch", () =>
    runEffect(
      Effect.gen(function* () {
        let checkedOut = "";
        const port = mockPort({
          branchExists: () => Effect.succeed(true),
          checkoutBranch: (_cwd, branch) =>
            Effect.sync(() => {
              checkedOut = branch;
            }),
        });
        const result = yield* ensureStackStep(
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
      }),
    ));

  it("creates a stacked branch when missing", () =>
    runEffect(
      Effect.gen(function* () {
        let created: { branch: string; parent: string } | undefined;
        const port = mockPort({
          createStackedBranch: (_cwd, branch, parent) =>
            Effect.sync(() => {
              created = { branch, parent };
            }),
        });
        const result = yield* ensureStackStep(
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
      }),
    ));

  it("refuses to switch branches with a dirty working tree", () =>
    runEffect(
      Effect.gen(function* () {
        const port = mockPort({ isWorkingTreeClean: () => Effect.succeed(false) });
        const result = yield* Effect.either(
          ensureStackStep(
            "/repo",
            {
              issueKey: "CPD-636",
              branch: "alavoie/cpd-635/cpd-636",
              parent: "alavoie/cpd-635-user-event-log",
            },
            port,
          ),
        );
        assert.equal(result._tag, "Left");
        if (result._tag === "Left") {
          assert.match(result.left.message, /dirty/);
        }
      }),
    ));
});
