import type { RepoStackStep } from "./plan.js";

/** Git + Graphite operations used by stack prep (mockable in tests). */
export interface GraphiteStackPort {
  branchExists(cwd: string, branch: string): Promise<boolean>;
  currentBranch(cwd: string): Promise<string>;
  isWorkingTreeClean(cwd: string): Promise<boolean>;
  checkoutBranch(cwd: string, branch: string): Promise<void>;
  /** Register branch with Graphite (no-op if already tracked). */
  trackBranch(cwd: string, branch: string, parent: string): Promise<void>;
  createStackedBranch(
    cwd: string,
    branch: string,
    parent: string,
  ): Promise<void>;
}

export interface EnsureStackResult {
  branch: string;
  action: "noop" | "checkout" | "create";
}

export async function ensureStackStep(
  cwd: string,
  step: RepoStackStep,
  port: GraphiteStackPort,
): Promise<EnsureStackResult> {
  if ((await port.currentBranch(cwd)) === step.branch) {
    return { branch: step.branch, action: "noop" };
  }
  if (!(await port.isWorkingTreeClean(cwd))) {
    throw new Error(
      `${cwd}: working tree is dirty — commit, stash, or clean before stack prep`,
    );
  }
  if (await port.branchExists(cwd, step.branch)) {
    await port.checkoutBranch(cwd, step.branch);
    return { branch: step.branch, action: "checkout" };
  }
  await port.createStackedBranch(cwd, step.branch, step.parent);
  return { branch: step.branch, action: "create" };
}
