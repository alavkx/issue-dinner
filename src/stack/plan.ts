import { sortByDependencies } from "../agent/runner.js";
import type { DinnerConfig } from "../config.js";
import { resolveIssueWorkspaces } from "../config/workspaces.js";
import type { JiraIssue } from "../jira/acli.js";
import { storyBranchName } from "./names.js";

export interface RepoStackStep {
  issueKey: string;
  branch: string;
  parent: string;
}

export function buildRepoStackPlan(
  issues: JiraIssue[],
  config: DinnerConfig,
  workspaceKey: string,
  stackBase: string,
  stackPrefix: string,
): RepoStackStep[] {
  const relevant = sortByDependencies(issues).filter((item) => {
    const roots = resolveIssueWorkspaces(
      config,
      item.key,
      item.description,
      item.summary,
    );
    return roots.keys.includes(workspaceKey);
  });

  const steps: RepoStackStep[] = [];
  let parent = stackBase;
  for (const item of relevant) {
    const branch = storyBranchName(stackPrefix, item.key);
    steps.push({ issueKey: item.key, branch, parent });
    parent = branch;
  }
  return steps;
}

export function buildEpicStackPlans(
  issues: JiraIssue[],
  config: DinnerConfig,
  stackBase: string,
  stackPrefix: string,
): Map<string, RepoStackStep[]> {
  const plans = new Map<string, RepoStackStep[]>();
  for (const workspaceKey of Object.keys(config.workspaces)) {
    plans.set(
      workspaceKey,
      buildRepoStackPlan(issues, config, workspaceKey, stackBase, stackPrefix),
    );
  }
  return plans;
}
