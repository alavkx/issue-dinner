import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { ResolvedVerifyCommand } from "./resolve.js";
import { effectiveVerifyTier } from "./tier.js";

export function pathArgsFromVerifyArgs(args: ReadonlyArray<string>): string[] {
  const paths: string[] = [];
  for (const arg of args) {
    if (arg.startsWith("-")) continue;
    if (arg === "run" || arg === "test" || arg === "--") continue;
    if (arg.includes("/") || arg.endsWith(".py") || arg.endsWith(".ts")) {
      paths.push(arg);
    }
  }
  return paths;
}

/** Pair integration route tests with sibling unit_test modules (fileservice2 layout). */
export function unitTestPathsBesideIntegration(
  cwd: string,
  integrationRel: string,
): string[] {
  const routesMatch = integrationRel.match(/test_([a-z0-9_]+)_routes\.py$/i);
  if (!routesMatch) return [];
  const feature = routesMatch[1]!;
  const unitDir = integrationRel
    .replace(/\/integration\//, "/unit_test/")
    .replace(/\/[^/]+$/, "");
  const absDir = join(cwd, unitDir);
  if (!existsSync(absDir)) return [];
  const prefix = `test_${feature}_`;
  return readdirSync(absDir)
    .filter((f) => f.startsWith(prefix) && f.endsWith(".py"))
    .map((f) => `${unitDir}/${f}`);
}

function rebuildPytestArgs(
  args: ReadonlyArray<string>,
  integrationPath: string,
  unitPaths: string[],
): string[] {
  const withoutIntegration = args.filter(
    (arg) =>
      arg !== integrationPath &&
      !(arg.endsWith(".py") && arg.includes("integration")),
  );
  const pytestIdx = withoutIntegration.indexOf("pytest");
  if (pytestIdx < 0) {
    return [...withoutIntegration, ...unitPaths];
  }
  const head = withoutIntegration.slice(0, pytestIdx + 1);
  const tail = withoutIntegration
    .slice(pytestIdx + 1)
    .filter((arg) => arg.startsWith("-") || arg === "--tb=short");
  return [...head, ...unitPaths, ...tail];
}

/** Derive fast unit tests from configured slow integration pytest targets. */
export function inferInnerVerifyCommands(
  commands: ResolvedVerifyCommand[],
): ResolvedVerifyCommand[] {
  const inferred: ResolvedVerifyCommand[] = [];
  const seen = new Set<string>();

  for (const cmd of commands) {
    if (effectiveVerifyTier(cmd) !== "outer") continue;
    const integrationPaths = pathArgsFromVerifyArgs(cmd.args).filter((p) =>
      p.includes("integration"),
    );
    for (const intPath of integrationPaths) {
      const unitPaths = unitTestPathsBesideIntegration(cmd.cwd, intPath);
      if (unitPaths.length === 0) continue;
      const dedupeKey = `${cmd.cwd}:${unitPaths.join("|")}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);

      const name = cmd.name.includes("integration")
        ? cmd.name.replace("integration", "unit")
        : `${cmd.name}-unit`;

      inferred.push({
        ...cmd,
        name,
        tier: "inner",
        args: rebuildPytestArgs(cmd.args, intPath, unitPaths),
      });
    }
  }

  return inferred;
}
