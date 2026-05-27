import {
  processIssue,
  sortByDependencies,
} from "../agent/runner.js";
import { cursorApiKey } from "../env.js";
import { buildLaunchShellCommand, launchInTmux } from "../launch/tmux.js";
import { findConfigPath } from "../config.js";
import { ensureAcli, fetchIssue, listEpicChildren } from "../jira/acli.js";
import { resolveCliExecutable } from "../paths.js";
import { filterMenuIssues, parseKeyList } from "../serve/filter.js";
import { createGraphiteStackPort } from "../stack/graphite-runner.js";
import { prepEpicStack } from "../stack/prep.js";
import { commandExists } from "../util/exec.js";
import { assertMealCommand } from "./parse-argv.js";
import { createMeal, mergeExclude, type EpicMeal } from "./meal.js";

function shellQuote(arg: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(arg)) return arg;
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

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
      for (const issue of issues) {
        const rec = meal.store.get(issue.key);
        const st = rec?.status ?? "pending";
        console.log(`${issue.key}  ${st.padEnd(14)}  ${issue.summary}`);
        if (rec?.handoffVerification)
          console.log(`         handoff=${rec.handoffVerification}`);
        if (rec?.agentId)
          console.log(`         agent=${rec.agentId} run=${rec.runId ?? "?"}`);
        if (rec?.error)
          console.log(`         error: ${rec.error.slice(0, 120)}`);
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
        console.log(
          `Would prep ${issues.length} stories for ${meal.epic} (${meal.stack.prefix}/*)`,
        );
        return;
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
      const skipDone = hasFlag(args, "--skip-done");
      const force = hasFlag(args, "--force");
      const continueOnError = hasFlag(args, "--continue-on-error");
      const skipVerify = hasFlag(args, "--skip-verify");

      console.log(`Menu for epic ${meal.epic} (${issues.length} courses)\n`);
      let failures = 0;

      for (const issue of issues) {
        if (skipDone && meal.store.isVerified(issue.key)) {
          console.log(`skip ${issue.key} (verified)`);
          continue;
        }
        if (!force && !dryRun) {
          const gate = meal.store.canProcess(issue.key, issue.parsed.blockedBy);
          if (!gate.ok) {
            console.log(`hold ${issue.key}: ${gate.reason}`);
            continue;
          }
        }

        if (dryRun) {
          await processIssue(issue, meal.machine, meal.store, cursorApiKey(), {
            dryRun: true,
            stack: meal.stack,
          });
          continue;
        }

        const result = await processIssue(
          issue,
          meal.machine,
          meal.store,
          cursorApiKey(),
          { skipVerify, stack: meal.stack },
        );
        if (result.status === "error") {
          failures += 1;
          console.error(`✗ ${issue.key} failed`);
          if (!continueOnError) {
            process.exitCode = 2;
            break;
          }
        }
      }

      if (failures > 0 && continueOnError) {
        console.error(
          `\n${failures} course(s) failed — see: issue-dinner ${meal.epic} status`,
        );
        process.exitCode = 2;
      }
      return;
    }
    case "launch": {
      const resolvedConfigPath = findConfigPath(configPath);
      const exclude = flagValue(args, "--exclude");
      const dryRun = hasFlag(args, "--dry-run");
      const noPrep = hasFlag(args, "--no-prep");

      if (!noPrep && !dryRun) {
        if (!commandExists("gt")) {
          throw new Error(
            "gt (Graphite) is not on PATH — use --no-prep to skip",
          );
        }
        await ensureAcli();
        console.log(`Preparing Graphite stacks for ${meal.epic}…`);
        const issues = await menuIssues(meal, exclude);
        await prepEpicStack(
          issues,
          meal.machine,
          meal.stack,
          createGraphiteStackPort(),
        );
      }

      const inner = buildServeInvocation(meal.epic, resolvedConfigPath, {
        continueOnError: !hasFlag(args, "--no-continue-on-error"),
        skipDone: !hasFlag(args, "--no-skip-done"),
        exclude,
        only: flagValue(args, "--only"),
        force: hasFlag(args, "--force"),
        skipVerify: hasFlag(args, "--skip-verify"),
        dryRun,
      });

      if (dryRun) {
        const session = flagValue(args, "--session") ?? "dinner";
        console.log(`# tmux session: ${session}`);
        console.log(buildLaunchShellCommand(inner));
        return;
      }

      cursorApiKey();
      launchInTmux({
        session: flagValue(args, "--session") ?? "dinner",
        innerCommand: inner,
        attach: hasFlag(args, "--attach"),
        detach: !hasFlag(args, "--no-detach"),
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
          "Warning: `cursor` CLI not found on PATH; local SDK may still work.",
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
      return;
    }
    default:
      throw new Error(`Unhandled meal command: ${command}`);
  }
}
