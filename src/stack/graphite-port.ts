import type * as CommandExecutor from "@effect/platform/CommandExecutor";
import * as Effect from "effect/Effect";
import type { RepoStackStep } from "./plan.js";

/** Git + Graphite operations used by stack prep (mockable in tests). */
export interface GraphiteStackPort {
  branchExists(
    cwd: string,
    branch: string,
  ): Effect.Effect<boolean, never, CommandExecutor.CommandExecutor>;
  currentBranch(
    cwd: string,
  ): Effect.Effect<
    string,
    import("@effect/platform/Error").PlatformError | import("../effect/errors.js").CommandFailed,
    CommandExecutor.CommandExecutor
  >;
  isWorkingTreeClean(
    cwd: string,
  ): Effect.Effect<
    boolean,
    import("@effect/platform/Error").PlatformError | import("../effect/errors.js").CommandFailed,
    CommandExecutor.CommandExecutor
  >;
  checkoutBranch(
    cwd: string,
    branch: string,
  ): Effect.Effect<
    void,
    import("@effect/platform/Error").PlatformError | import("../effect/errors.js").CommandFailed,
    CommandExecutor.CommandExecutor
  >;
  /** Register branch with Graphite (no-op if already tracked). */
  trackBranch(
    cwd: string,
    branch: string,
    parent: string,
  ): Effect.Effect<
    void,
    import("@effect/platform/Error").PlatformError | import("../effect/errors.js").CommandFailed,
    CommandExecutor.CommandExecutor
  >;
  createStackedBranch(
    cwd: string,
    branch: string,
    parent: string,
  ): Effect.Effect<
    void,
    | Error
    | import("@effect/platform/Error").PlatformError
    | import("../effect/errors.js").CommandFailed,
    CommandExecutor.CommandExecutor
  >;
}

export interface EnsureStackResult {
  branch: string;
  action: "noop" | "checkout" | "create";
}

export const ensureStackStep = (
  cwd: string,
  step: RepoStackStep,
  port: GraphiteStackPort,
): Effect.Effect<
  EnsureStackResult,
  Error,
  CommandExecutor.CommandExecutor
> =>
  Effect.gen(function* () {
    if ((yield* port.currentBranch(cwd)) === step.branch) {
      return { branch: step.branch, action: "noop" as const };
    }
    if (!(yield* port.isWorkingTreeClean(cwd))) {
      return yield* Effect.fail(
        new Error(
          `${cwd}: working tree is dirty — commit, stash, or clean before stack prep`,
        ),
      );
    }
    if (yield* port.branchExists(cwd, step.branch)) {
      yield* port.checkoutBranch(cwd, step.branch);
      return { branch: step.branch, action: "checkout" as const };
    }
    yield* port.createStackedBranch(cwd, step.branch, step.parent);
    return { branch: step.branch, action: "create" as const };
  });
