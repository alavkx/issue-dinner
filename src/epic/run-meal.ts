import {
  processIssue,
  sortByDependencies,
  verifyIssue,
} from "../agent/runner.js";
import { cursorApiKey } from "../env.js";
import {
  assertPreflight,
  formatPreflightReport,
  runPreflight,
} from "../doctor/preflight.js";
import { buildLaunchShellCommand, launchInTmux } from "../launch/tmux.js";
import { findConfigPath } from "../config.js";
import { ensureAcli, fetchIssue, listEpicChildren } from "../jira/acli.js";
import { resolveCliExecutable } from "../paths.js";
import { ServeLogger } from "../serve/log.js";
import type { ServeHaltInfo } from "../serve/failures.js";
import { menuOrderBlocks } from "../serve/menu-gate.js";
import { printServeSummary } from "../serve/summary.js";
import { ensureWorkspacesCleanForIssue } from "../serve/workspace-gate.js";
import { formatAgentError } from "../agent/sdk-errors.js";
import { setServeShutdownHandler } from "../runtime/guards.js";
import * as out from "../ui/out.js";
import { filterMenuIssues, parseKeyList } from "../serve/filter.js";
import { createGraphiteStackPort } from "../stack/graphite-runner.js";
import { prepEpicStack } from "../stack/prep.js";
import { buildEpicStackPlans } from "../stack/plan.js";
import { storyBranchName } from "../stack/names.js";
import { commandExists, shellQuote } from "../util/exec.js";
import { assertMealCommand } from "./parse-argv.js";
import { createMeal, mergeExclude, type EpicMeal } from "./meal.js";

function buildServeInvocation(
  epic: string,
  configPath: string | undefined,
  flags: {
    continueOnError?: boolean;
    skipDone?: boolean;
    exclude?: string;
    only?: string;
    force?: boolean;
    skipVerify?: boolean;
    skipPreflight?: boolean;
    dryRun?: boolean;
  },
): string {
  const parts = [shellQuote(resolveCliExecutable()), shellQuote(epic)];
  if (configPath) parts.push("-c", shellQuote(configPath));
  parts.push("serve");
  if (flags.dryRun) parts.push("--dry-run");
  if (flags.skipDone) parts.push("--skip-done");
  if (flags.continueOnError) parts.push("--continue-on-error");
  if (flags.force) parts.push("--force");
  if (flags.skipVerify) parts.push("--skip-verify");
  if (flags.skipPreflight) parts.push("--skip-preflight");
  if (flags.only) parts.push("--only", shellQuote(flags.only));
  if (flags.exclude) parts.push("--exclude", shellQuote(flags.exclude));
  return parts.join(" ");
}

function flagValue(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i >= 0) return args[i + 1];
  return undefined;
}

function hasFlag(args: string[], name: string): boolean {
  return args.includes(name);
}

async function menuIssues(
  meal: EpicMeal,
  excludeCsv?: string,
): Promise<ReturnType<typeof filterMenuIssues>> {
  return filterMenuIssues(await listEpicChildren(meal.epic), {
    exclude: mergeExclude(meal, excludeCsv),
  });
}

async function runMealPreflight(
  meal: EpicMeal,
  menu: Awaited<ReturnType<typeof menuIssues>>,
  options: {
    requireApiKey?: boolean;
    checkGraphite?: boolean;
    checkTmux?: boolean;
    validateVerify?: boolean;
  },
): Promise<void> {
  const report = await runPreflight({
    config: meal.machine,
    stack: meal.stack,
    menuIssues: menu,
    store: meal.store,
    ...options,
  });
  console.log(formatPreflightReport(report));
  console.log("");
  assertPreflight(report);
}

function printDryRunMenuPlan(
  meal: EpicMeal,
  issues: Awaited<ReturnType<typeof menuIssues>>,
): void {
  console.log(`Menu plan for ${meal.epic} (${issues.length} courses):\n`);
  for (const issue of sortByDependencies(issues)) {
    const branch = storyBranchName(meal.stack.prefix, issue.key);
    const gate = meal.store.canProcess(issue.key, issue.parsed.blockedBy);
    const rec = meal.store.get(issue.key);
    const skip =
      meal.store.isVerified(issue.key) ? "skip (verified)" : undefined;
    const hold = !gate.ok ? `hold: ${gate.reason}` : undefined;
    const state = rec?.status ? `[${rec.status}]` : "";
    console.log(
      `  ${issue.key}  ${branch}  ${skip ?? hold ?? state ?? "would run"}`,
    );
  }
  console.log("");
}

export async function runMealArgv(
  epic: string,
  argv: string[],
  configPath?: string,
): Promise<void> {
  const command = assertMealCommand(argv[0]);
  const args = argv.slice(1);
  const meal = createMeal(epic, { configPath });

  switch (command) {
    case "list": {
      await ensureAcli();
      const issues = await menuIssues(meal, flagValue(args, "--exclude"));
      console.log(`Epic ${meal.epic} — ${issues.length} stories\n`);
      for (const issue of issues) {
        const rec = meal.store.get(issue.key);
        const run = rec?.status ? ` [${rec.status}]` : "";
        const blockers =
          issue.parsed.blockedBy.length > 0
            ? ` ← ${issue.parsed.blockedBy.join(", ")}`
            : "";
        console.log(
          `${issue.key}  ${issue.status}${run}  ${issue.summary}${blockers}`,
        );
      }
      return;
    }
    case "status": {
      await ensureAcli();
      const issues = await menuIssues(meal);
      const verbose = hasFlag(args, "--verbose");
      for (const issue of issues) {
        const rec = meal.store.get(issue.key);
        const st = rec?.status ?? "pending";
        console.log(`${issue.key}  ${st.padEnd(14)}  ${issue.summary}`);
        if (rec?.handoffVerification) {
          console.log(
            `         handoff=${rec.handoffStatus}/${rec.handoffVerification}`,
          );
        }
        if (rec?.verifyError) {
          console.log(`         verify failed: ${rec.verifyError}`);
        }
        if (rec?.branches && verbose) {
          for (const [ws, branch] of Object.entries(rec.branches)) {
            const sha = rec.commits?.[ws];
            console.log(
              `         ${ws}: ${branch}${sha ? ` @ ${sha}` : ""}`,
            );
          }
        }
        if (rec?.agentId) {
          console.log(`         agent=${rec.agentId} run=${rec.runId ?? "?"}`);
        }
        if (rec?.error && st === "error") {
          console.log(`         error: ${rec.error.slice(0, 200)}`);
        }
        if (rec?.resolutionSteps?.length) {
          for (const step of rec.resolutionSteps.slice(-4)) {
            console.log(`         → ${step}`);
          }
        }
        if (rec?.transcriptPath && verbose) {
          console.log(`         transcript: ${rec.transcriptPath}`);
        }
      }
      return;
    }
    case "prep": {
      if (!commandExists("gt")) {
        throw new Error("gt (Graphite) is not on PATH");
      }
      await ensureAcli();
      const issues = await menuIssues(meal, flagValue(args, "--exclude"));
      if (hasFlag(args, "--dry-run")) {
        const plans = buildEpicStackPlans(
          issues,
          meal.machine,
          meal.stack.base,
          meal.stack.prefix,
        );
        console.log(
          `Would prep ${issues.length} stories for ${meal.epic} (${meal.stack.prefix}/*)\n`,
        );
        for (const [workspaceKey, steps] of plans) {
          for (const step of steps) {
            console.log(
              `  ${workspaceKey}  ${step.issueKey}  ${step.branch}  (parent: ${step.parent})`,
            );
          }
        }
        return;
      }
      if (!hasFlag(args, "--skip-preflight")) {
        await runMealPreflight(meal, issues, {
          checkGraphite: true,
          checkTmux: false,
          validateVerify: false,
        });
      }
      const summary = await prepEpicStack(
        issues,
        meal.machine,
        meal.stack,
        createGraphiteStackPort(),
      );
      for (const row of summary) {
        console.log(
          `${row.workspace}  ${row.issueKey}  ${row.action.padEnd(8)}  ${row.branch}`,
        );
      }
      return;
    }
    case "serve": {
      await ensureAcli();
      const exclude = mergeExclude(meal, flagValue(args, "--exclude"));
      const issues = sortByDependencies(
        filterMenuIssues(await listEpicChildren(meal.epic), {
          exclude,
          only: parseKeyList(flagValue(args, "--only")),
        }),
      );
      const dryRun = hasFlag(args, "--dry-run");
      const skipDone = !hasFlag(args, "--no-skip-done");
      const force = hasFlag(args, "--force");
      const continueOnError = hasFlag(args, "--continue-on-error");
      const skipVerify = hasFlag(args, "--skip-verify");
      const skipPreflight = hasFlag(args, "--skip-preflight");

      if (!dryRun && !skipPreflight) {
        await runMealPreflight(meal, issues, {
          checkGraphite: false,
          checkTmux: false,
        });
      } else if (dryRun) {
        const report = await runPreflight({
          config: meal.machine,
          stack: meal.stack,
          menuIssues: issues,
          store: meal.store,
          checkGraphite: false,
          checkTmux: false,
        });
        console.log(formatPreflightReport(report));
        console.log("");
        printDryRunMenuPlan(meal, issues);
      }

      const recoverStale = (): string[] => {
        const keys = meal.store.recoverStaleRunning();
        if (keys.length > 0) {
          console.log(`Recovered stale running: ${keys.join(", ")}\n`);
        }
        return keys;
      };

      recoverStale();

      setServeShutdownHandler(() => {
        recoverStale();
      });

      let sigintHandler: (() => void) | undefined;
      if (!dryRun) {
        sigintHandler = () => {
          out.warn("Interrupted — marking in-flight courses and exiting");
          recoverStale();
          process.exitCode = 130;
          process.exit(130);
        };
        process.once("SIGINT", sigintHandler);
      }

      out.banner(`Issue dinner — ${meal.epic} (${issues.length} courses)`);

      let logger: ServeLogger | undefined;
      if (!dryRun) {
        logger = ServeLogger.open(meal.epic);
        logger.attach();
        console.log(`Logging to ${logger.logPath}\n`);
      }

      let failures = 0;
      const held: Array<{ key: string; reason: string }> = [];
      const skipped: string[] = [];
      const skippedSet = new Set<string>();
      let halt: ServeHaltInfo | undefined;

      try {
        for (let courseIndex = 0; courseIndex < issues.length; courseIndex++) {
          const issue = issues[courseIndex]!;
          if (skipDone && meal.store.isVerified(issue.key)) {
            out.skipCourse(issue.key, "verified");
            skipped.push(issue.key);
            skippedSet.add(issue.key);
            continue;
          }
          if (!force && !dryRun) {
            const orderGate = menuOrderBlocks(
              meal.store,
              issues,
              courseIndex,
              skippedSet,
            );
            if (!orderGate.ok) {
              out.holdCourse(issue.key, orderGate.reason ?? "blocked");
              held.push({
                key: issue.key,
                reason: orderGate.reason ?? "blocked",
              });
              continue;
            }
          }
          if (!force && !dryRun) {
            const gate = meal.store.canProcess(
              issue.key,
              issue.parsed.blockedBy,
            );
            if (!gate.ok) {
              out.holdCourse(issue.key, gate.reason ?? "blocked");
              held.push({ key: issue.key, reason: gate.reason ?? "blocked" });
              continue;
            }
          } else if (!force && dryRun) {
            const gate = meal.store.canProcess(
              issue.key,
              issue.parsed.blockedBy,
            );
            if (!gate.ok) {
              console.log(`[dry-run] hold ${issue.key}: ${gate.reason}`);
              held.push({ key: issue.key, reason: gate.reason ?? "blocked" });
              continue;
            }
          }

          if (dryRun) {
            await processIssue(
              issue,
              meal.machine,
              meal.store,
              cursorApiKey(),
              { dryRun: true, stack: meal.stack },
            );
            continue;
          }

          const prior = meal.store.get(issue.key);
          if (prior?.status === "agent_complete" && !skipVerify) {
            out.info(`${issue.key}: retrying verify (previous agent_complete)`);
            const retry = await verifyIssue(
              issue,
              meal.machine,
              meal.store,
            );
            if (retry.status === "verified") {
              continue;
            }
          }

          let result;
          try {
            result = await processIssue(
              issue,
              meal.machine,
              meal.store,
              cursorApiKey(),
              { skipVerify, stack: meal.stack, epic: meal.epic },
            );
          } catch (err) {
            const message = formatAgentError(err);
            failures += 1;
            meal.store.upsert({
              issueKey: issue.key,
              summary: issue.summary,
              status: "error",
              error: message,
              finishedAt: new Date().toISOString(),
            });
            halt = {
              issueKey: issue.key,
              summary: issue.summary,
              reason: message,
            };
            out.error(`${issue.key} crashed: ${message}`);
            process.exitCode = 2;
            break;
          }

          if (result.status === "error") {
            failures += 1;
            halt = {
              issueKey: issue.key,
              summary: issue.summary,
              reason: result.error ?? "course failed",
            };
            out.error(`✗ ${issue.key} failed — ${halt.reason}`);
            process.exitCode = 2;
            if (!continueOnError) break;
            continue;
          }

          if (result.status === "agent_complete") {
            failures += 1;
            halt = {
              issueKey: issue.key,
              summary: issue.summary,
              reason: result.error ?? "inner verify failed",
            };
            out.error(
              `${issue.key} agent complete — inner verify failed (${result.error ?? "see log"})`,
            );
            if (!continueOnError) {
              process.exitCode = 2;
              break;
            }
          }

          const clean = await ensureWorkspacesCleanForIssue(
            meal.machine,
            issue,
            { label: "before next course" },
          );
          if (!clean.ok) {
            failures += 1;
            const reason =
              clean.detail ??
              "dirty workspace after course — cannot advance stack";
            halt = {
              issueKey: issue.key,
              summary: issue.summary,
              reason,
            };
            out.error(
              `${issue.key} left repo dirty — halting menu (fix git, then re-serve)`,
            );
            process.exitCode = 2;
            break;
          }
        }
      } finally {
        if (sigintHandler) {
          process.off("SIGINT", sigintHandler);
        }
        setServeShutdownHandler(undefined);
        if (!dryRun) {
          recoverStale();
          printServeSummary({
            epic: meal.epic,
            stack: meal.stack,
            issues,
            store: meal.store,
            held,
            skipped,
            logPath: logger?.logPath,
            halt,
          });
          logger?.close();
        }
      }

      if (failures > 0 && continueOnError) {
        process.exitCode = 2;
      }
      return;
    }
    case "launch": {
      const resolvedConfigPath = findConfigPath(configPath);
      const exclude = flagValue(args, "--exclude");
      const dryRun = hasFlag(args, "--dry-run");
      const noPrep = hasFlag(args, "--no-prep");
      const skipPreflight = hasFlag(args, "--skip-preflight");

      await ensureAcli();
      const issues = await menuIssues(meal, exclude);

      if (!skipPreflight) {
        await runMealPreflight(meal, issues, {
          checkGraphite: !noPrep,
          checkTmux: !dryRun,
        });
      }

      if (!noPrep && !dryRun) {
        if (!commandExists("gt")) {
          throw new Error(
            "gt (Graphite) is not on PATH — use --no-prep to skip",
          );
        }
        console.log(`Preparing Graphite stacks for ${meal.epic}…`);
        await prepEpicStack(
          issues,
          meal.machine,
          meal.stack,
          createGraphiteStackPort(),
        );
      } else if (dryRun && !noPrep) {
        const plans = buildEpicStackPlans(
          issues,
          meal.machine,
          meal.stack.base,
          meal.stack.prefix,
        );
        console.log(`Would prep ${issues.length} stories:\n`);
        for (const [workspaceKey, steps] of plans) {
          for (const step of steps) {
            console.log(`  ${workspaceKey}  ${step.branch}`);
          }
        }
        console.log("");
      }

      const inner = buildServeInvocation(meal.epic, resolvedConfigPath, {
        continueOnError: hasFlag(args, "--continue-on-error"),
        skipDone: !hasFlag(args, "--no-skip-done"),
        exclude,
        only: flagValue(args, "--only"),
        force: hasFlag(args, "--force"),
        skipVerify: hasFlag(args, "--skip-verify"),
        skipPreflight: true,
        dryRun,
      });

      const apiKey =
        process.env.ISSUE_DINNER_CURSOR_API_KEY?.trim() ??
        (dryRun ? "" : cursorApiKey());

      if (dryRun) {
        printDryRunMenuPlan(meal, issues);
        const session = flagValue(args, "--session") ?? "dinner";
        const detach = hasFlag(args, "--detach");
        console.log(
          `# tmux session: ${session}${detach ? " (detached)" : " (attached)"}`,
        );
        console.log(buildLaunchShellCommand(inner, apiKey));
        return;
      }

      launchInTmux({
        session: flagValue(args, "--session") ?? "dinner",
        innerCommand: inner,
        apiKey: cursorApiKey(),
        epic: meal.epic,
        detach: hasFlag(args, "--detach"),
      });
      return;
    }
    case "cook": {
      const key = args[0];
      if (!key || key.startsWith("-")) {
        throw new Error(
          "cook requires a story key: issue-dinner CPD-635 cook CPD-636",
        );
      }
      const cookArgs = args.slice(1);
      await ensureAcli();
      if (!hasFlag(cookArgs, "--dry-run") && !commandExists("cursor")) {
        console.warn(
          "Warning: `cursor` CLI not found on PATH; local SDK agents require it.",
        );
      }
      const issue = await fetchIssue(key);
      const dryRun = hasFlag(cookArgs, "--dry-run");
      if (!hasFlag(cookArgs, "--force") && !dryRun) {
        const gate = meal.store.canProcess(key, issue.parsed.blockedBy);
        if (!gate.ok) throw new Error(gate.reason);
      }
      const result = await processIssue(
        issue,
        meal.machine,
        meal.store,
        cursorApiKey(),
        {
          dryRun,
          stream: !hasFlag(cookArgs, "--no-stream"),
          resumeAgentId: flagValue(cookArgs, "--resume"),
          skipVerify: hasFlag(cookArgs, "--skip-verify"),
          stack: meal.stack,
        },
      );
      if (result.status === "error") process.exitCode = 2;
      if (result.status === "agent_complete") process.exitCode = 2;
      return;
    }
    default:
      throw new Error(`Unhandled meal command: ${command}`);
  }
}
