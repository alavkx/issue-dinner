import type { MachineConfig } from "../config.js";
import { resolveCwd, resolveIssueWorkspaces } from "../config/workspaces.js";
import type * as CommandExecutor from "@effect/platform/CommandExecutor";
import * as Effect from "effect/Effect";
import type { JiraIssue } from "../jira/acli.js";
import { ensureStackStep, type GraphiteStackPort } from "./graphite-port.js";
import {
  buildEpicStackPlans,
  buildRepoStackPlan,
  type RepoStackStep,
} from "./plan.js";
import type { StackConfig } from "./stack-config.js";

export interface StackActionSummary {
  workspace: string;
  cwd: string;
  issueKey: string;
  branch: string;
  action: "noop" | "checkout" | "create";
}

const ensureStackBase = (
  cwd: string,
  stack: StackConfig,
  port: GraphiteStackPort,
): Effect.Effect<void, Error, CommandExecutor.CommandExecutor> =>
  Effect.gen(function* () {
    if (yield* port.branchExists(cwd, stack.base)) {
      if ((yield* port.currentBranch(cwd)) !== stack.base) {
        if (!(yield* port.isWorkingTreeClean(cwd))) {
          return yield* Effect.fail(
            new Error(
              `${cwd}: working tree is dirty — commit, stash, or clean before stack prep`,
            ),
          );
        }
        yield* port.checkoutBranch(cwd, stack.base);
      }
      yield* port.trackBranch(cwd, stack.base, stack.graphiteTrunk);
      if (stack.base !== `${stack.prefix}-trunk`) {
        console.warn(
          `   ${cwd}: stack base "${stack.base}" tracked on ${stack.graphiteTrunk} (stackBaseOverride)`,
        );
      }
      return;
    }

    if (!(yield* port.isWorkingTreeClean(cwd))) {
      return yield* Effect.fail(
        new Error(
          `${cwd}: working tree is dirty — commit, stash, or clean before creating stack base`,
        ),
      );
    }

    if (!(yield* port.branchExists(cwd, stack.graphiteTrunk))) {
      return yield* Effect.fail(
        new Error(
          `${cwd}: graphite trunk "${stack.graphiteTrunk}" not found — fetch or create it first`,
        ),
      );
    }

    yield* port.checkoutBranch(cwd, stack.graphiteTrunk);
    yield* port.createStackedBranch(cwd, stack.base, stack.graphiteTrunk);
  });

export const prepEpicStack = (
  issues: JiraIssue[],
  config: MachineConfig,
  stack: StackConfig,
  port: GraphiteStackPort,
): Effect.Effect<
  StackActionSummary[],
  Error,
  CommandExecutor.CommandExecutor
> =>
  Effect.gen(function* () {
    const plans = buildEpicStackPlans(issues, config, stack.base, stack.prefix);
    const summary: StackActionSummary[] = [];

    for (const [workspaceKey, steps] of plans) {
      const cwd = resolveCwd(config, workspaceKey);
      yield* ensureStackBase(cwd, stack, port);

      for (const step of steps) {
        const result = yield* ensureStackStep(cwd, step, port);
        summary.push({
          workspace: workspaceKey,
          cwd,
          issueKey: step.issueKey,
          branch: result.branch,
          action: result.action,
        });
      }
    }

    return summary;
  });

function stepForIssue(
  issue: JiraIssue,
  config: MachineConfig,
  stack: StackConfig,
  workspaceKey: string,
): RepoStackStep | undefined {
  const plan = buildRepoStackPlan(
    [issue],
    config,
    workspaceKey,
    stack.base,
    stack.prefix,
  );
  return plan[0];
}

export const checkoutIssueStack = (
  issue: JiraIssue,
  config: MachineConfig,
  stack: StackConfig,
  port: GraphiteStackPort,
): Effect.Effect<
  StackActionSummary[],
  Error,
  CommandExecutor.CommandExecutor
> =>
  Effect.gen(function* () {
    const roots = resolveIssueWorkspaces(
      config,
      issue.key,
      issue.description,
      issue.summary,
    );
    const summary: StackActionSummary[] = [];

    for (const workspaceKey of roots.keys) {
      const step = stepForIssue(issue, config, stack, workspaceKey);
      if (!step) continue;
      const cwd = resolveCwd(config, workspaceKey);
      yield* ensureStackBase(cwd, stack, port);
      const result = yield* ensureStackStep(cwd, step, port);
      summary.push({
        workspace: workspaceKey,
        cwd,
        issueKey: issue.key,
        branch: result.branch,
        action: result.action,
      });
    }

    return summary;
  });
