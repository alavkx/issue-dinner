import * as Effect from "effect/Effect";
import { runCommand } from "../util/exec.js";
import type { GraphiteStackPort } from "./graphite-port.js";

export function createGraphiteStackPort(): GraphiteStackPort {
  const git = (cwd: string, ...args: string[]) =>
    runCommand("git", args, { cwd }).pipe(
      Effect.map(({ stdout }) => stdout.trim()),
    );

  const gt = (cwd: string, ...args: string[]) =>
    runCommand("gt", ["--no-interactive", "-q", "--cwd", cwd, ...args], {
      cwd,
    }).pipe(Effect.map(({ stdout }) => stdout.trim()));

  const port: GraphiteStackPort = {
    branchExists: (cwd, branch) =>
      git(cwd, "rev-parse", "--verify", `refs/heads/${branch}`).pipe(
        Effect.as(true),
        Effect.catchAll(() => Effect.succeed(false)),
      ),

    currentBranch: (cwd) => git(cwd, "branch", "--show-current"),

    isWorkingTreeClean: (cwd) =>
      git(cwd, "status", "--porcelain").pipe(
        Effect.map((status) => status.length === 0),
      ),

    checkoutBranch: (cwd, branch) =>
      gt(cwd, "branch", "checkout", branch).pipe(
        Effect.catchAll(() =>
          git(cwd, "checkout", branch).pipe(Effect.asVoid),
        ),
      ),

    trackBranch: (cwd, branch, parent) =>
      Effect.gen(function* () {
        if ((yield* port.currentBranch(cwd)) !== branch) {
          yield* port.checkoutBranch(cwd, branch);
        }
        yield* gt(cwd, "track", "--parent", parent).pipe(Effect.asVoid);
      }),

    createStackedBranch: (cwd, branch, parent) =>
      Effect.gen(function* () {
        if (!(yield* port.branchExists(cwd, parent))) {
          return yield* Effect.fail(
            new Error(
              `${cwd}: parent branch "${parent}" does not exist — run prep for the epic base first`,
            ),
          );
        }
        yield* port.checkoutBranch(cwd, parent);
        yield* gt(cwd, "branch", "create", branch).pipe(Effect.asVoid);
      }),
  };

  return port;
}
