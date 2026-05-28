import { PlatformLive } from "../effect/layers.js";
import * as Effect from "effect/Effect";
import { runCommand } from "../util/exec.js";
import type { GraphiteStackPort } from "./graphite-port.js";

const runCmd = <A, E>(
  program: Effect.Effect<
    A,
    E,
    import("@effect/platform/CommandExecutor").CommandExecutor
  >,
): Promise<A> => Effect.runPromise(program.pipe(Effect.provide(PlatformLive)));

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await runCmd(runCommand("git", args, { cwd }));
  return stdout.trim();
}

async function gt(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await runCmd(
    runCommand("gt", ["--no-interactive", "-q", "--cwd", cwd, ...args], {
      cwd,
    }),
  );
  return stdout.trim();
}

export function createGraphiteStackPort(): GraphiteStackPort {
  const port: GraphiteStackPort = {
    async branchExists(cwd, branch) {
      try {
        await git(cwd, "rev-parse", "--verify", `refs/heads/${branch}`);
        return true;
      } catch {
        return false;
      }
    },

    currentBranch(cwd) {
      return git(cwd, "branch", "--show-current");
    },

    async isWorkingTreeClean(cwd) {
      const status = await git(cwd, "status", "--porcelain");
      return status.length === 0;
    },

    async checkoutBranch(cwd, branch) {
      try {
        await gt(cwd, "branch", "checkout", branch);
      } catch {
        await git(cwd, "checkout", branch);
      }
    },

    async trackBranch(cwd, branch, parent) {
      if ((await port.currentBranch(cwd)) !== branch) {
        await port.checkoutBranch(cwd, branch);
      }
      await gt(cwd, "track", "--parent", parent);
    },

    async createStackedBranch(cwd, branch, parent) {
      if (!(await port.branchExists(cwd, parent))) {
        throw new Error(
          `${cwd}: parent branch "${parent}" does not exist — run prep for the epic base first`,
        );
      }
      await port.checkoutBranch(cwd, parent);
      await gt(cwd, "branch", "create", branch);
    },
  };
  return port;
}
