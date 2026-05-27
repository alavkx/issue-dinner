import type { DinnerConfig } from "../config.js";
import { resolveCwd, resolveIssueWorkspaces } from "../config/workspaces.js";
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

async function ensureStackBase(
  cwd: string,
  stack: StackConfig,
  port: GraphiteStackPort,
): Promise<void> {
  if (await port.branchExists(cwd, stack.base)) {
    if ((await port.currentBranch(cwd)) !== stack.base) {
      if (!(await port.isWorkingTreeClean(cwd))) {
        throw new Error(
          `${cwd}: working tree is dirty — commit, stash, or clean before stack prep`,
        );
      }
      await port.checkoutBranch(cwd, stack.base);
    }
    await port.trackBranch(cwd, stack.base, stack.graphiteTrunk);
    return;
  }

  if (!(await port.isWorkingTreeClean(cwd))) {
    throw new Error(
      `${cwd}: working tree is dirty — commit, stash, or clean before creating stack base`,
    );
  }

  if (!(await port.branchExists(cwd, stack.graphiteTrunk))) {
    throw new Error(
      `${cwd}: graphite trunk "${stack.graphiteTrunk}" not found — fetch or create it first`,
    );
  }

  await port.checkoutBranch(cwd, stack.graphiteTrunk);
  await port.createStackedBranch(cwd, stack.base, stack.graphiteTrunk);
}

export async function prepEpicStack(
  issues: JiraIssue[],
  config: DinnerConfig,
  stack: StackConfig,
  port: GraphiteStackPort,
): Promise<StackActionSummary[]> {
  const plans = buildEpicStackPlans(issues, config, stack.base, stack.prefix);
  const summary: StackActionSummary[] = [];

  for (const [workspaceKey, steps] of plans) {
    const cwd = resolveCwd(config, workspaceKey);
    await ensureStackBase(cwd, stack, port);

    for (const step of steps) {
      const result = await ensureStackStep(cwd, step, port);
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
}

function stepForIssue(
  issue: JiraIssue,
  config: DinnerConfig,
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

export async function checkoutIssueStack(
  issue: JiraIssue,
  config: DinnerConfig,
  stack: StackConfig,
  port: GraphiteStackPort,
): Promise<StackActionSummary[]> {
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
    await ensureStackBase(cwd, stack, port);
    const result = await ensureStackStep(cwd, step, port);
    summary.push({
      workspace: workspaceKey,
      cwd,
      issueKey: issue.key,
      branch: result.branch,
      action: result.action,
    });
  }

  return summary;
}
