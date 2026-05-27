#!/usr/bin/env node
import { resolve } from "node:path";
import { Command } from "commander";
import { processIssue, sortByDependencies, verifyIssue } from "./agent/runner.js";
import { loadConfig } from "./config.js";
import { ensureAcli, fetchIssue, listEpicChildren } from "./jira/acli.js";
import { filterMenuIssues, parseKeyList } from "./serve/filter.js";
import { StateStore } from "./state/store.js";
import { commandExists } from "./util/exec.js";

const program = new Command();

program
  .name("issue-dinner")
  .description("Serve Jira vertical-slice issues via the Cursor TypeScript SDK")
  .option("-c, --config <path>", "Path to issue-dinner.config.json");

function globalConfig(cmd: Command): string | undefined {
  return cmd.optsWithGlobals().config as string | undefined;
}

function apiKey(): string {
  const key = process.env.CURSOR_API_KEY;
  if (!key?.trim()) {
    throw new Error(
      "CURSOR_API_KEY is not set. Export a key from https://cursor.com/dashboard/integrations",
    );
  }
  return key.trim();
}

function stateStore(): StateStore {
  return new StateStore(resolve(process.cwd(), ".state"));
}

function defaultExclude(config: ReturnType<typeof loadConfig>): Set<string> {
  return new Set(config.exclude ?? []);
}

program
  .command("list")
  .description("List child stories under an epic")
  .argument("[epic]", "Epic key (default from config)")
  .option("--exclude <keys>", "Comma-separated keys to hide (merged with config.exclude)")
  .action(async (epicArg: string | undefined, opts: { exclude?: string }, cmd: Command) => {
    await ensureAcli();
    const config = loadConfig(globalConfig(cmd));
    const epic = epicArg ?? config.epic;
    if (!epic) throw new Error("Epic key required (arg or config.epic)");

    const exclude = defaultExclude(config);
    for (const k of parseKeyList(opts.exclude) ?? []) exclude.add(k);

    const issues = filterMenuIssues(await listEpicChildren(epic), { exclude });
    const store = stateStore();
    store.setEpic(epic);

    console.log(`Epic ${epic} — ${issues.length} stories\n`);
    for (const issue of issues) {
      const rec = store.get(issue.key);
      const run = rec?.status ? ` [${rec.status}]` : "";
      const blockers =
        issue.parsed.blockedBy.length > 0
          ? ` ← ${issue.parsed.blockedBy.join(", ")}`
          : "";
      console.log(
        `${issue.key}  ${issue.status}${run}  ${issue.summary}${blockers}`,
      );
    }
  });

program
  .command("show")
  .description("Print parsed issue body")
  .argument("<key>", "Issue key e.g. CPD-636")
  .action(async (key: string, _opts: unknown, cmd: Command) => {
    await ensureAcli();
    loadConfig(globalConfig(cmd));
    const issue = await fetchIssue(key);
    console.log(`${issue.key}: ${issue.summary} (${issue.status})\n`);
    console.log(issue.description);
    console.log("\n--- parsed ---");
    console.log(JSON.stringify(issue.parsed, null, 2));
  });

program
  .command("status")
  .description("Show local processing state")
  .option("--epic <key>", "Filter to epic children only")
  .action(async (opts: { epic?: string }, _o: unknown, cmd: Command) => {
    const config = loadConfig(globalConfig(cmd));
    const store = stateStore();
    const epic = opts.epic ?? config.epic;

    if (epic) {
      await ensureAcli();
      const exclude = defaultExclude(config);
      const issues = filterMenuIssues(await listEpicChildren(epic), {
        exclude,
      });
      for (const issue of issues) {
        const rec = store.get(issue.key);
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

    for (const rec of store.list()) {
      console.log(`${rec.issueKey}  ${rec.status}  ${rec.summary}`);
    }
  });

program
  .command("cook")
  .description("Run a Cursor agent for one issue, then verify")
  .argument("<key>", "Issue key e.g. CPD-636")
  .option("--dry-run", "Print prompt without calling the SDK")
  .option("--no-stream", "Wait without streaming assistant text")
  .option("--resume <agentId>", "Resume a previous agent")
  .option("--force", "Run even if blockers are not finished locally")
  .option("--skip-verify", "Skip configured verify commands (not recommended)")
  .action(
    async (
      key: string,
      opts: {
        dryRun?: boolean;
        noStream?: boolean;
        resume?: string;
        force?: boolean;
        skipVerify?: boolean;
      },
      cmd: Command,
    ) => {
      await ensureAcli();
      if (!opts.dryRun && !commandExists("cursor")) {
        console.warn(
          "Warning: `cursor` CLI not found on PATH; local SDK may still work.",
        );
      }

      const config = loadConfig(globalConfig(cmd));
      const store = stateStore();
      const issue = await fetchIssue(key);

      if (!opts.force && !opts.dryRun) {
        const gate = store.canProcess(key, issue.parsed.blockedBy);
        if (!gate.ok) {
          throw new Error(gate.reason);
        }
      }

      const result = await processIssue(issue, config, store, apiKey(), {
        dryRun: opts.dryRun,
        stream: !opts.noStream,
        resumeAgentId: opts.resume,
        skipVerify: opts.skipVerify,
      });

      if (result.status === "error") {
        process.exitCode = 2;
      }
    },
  );

program
  .command("verify")
  .description("Re-run verify commands for an issue (after agent_complete)")
  .argument("<key>", "Issue key")
  .action(async (key: string, _opts: unknown, cmd: Command) => {
    const config = loadConfig(globalConfig(cmd));
    const store = stateStore();
    await ensureAcli();
    const issue = await fetchIssue(key);
    const result = await verifyIssue(issue, config, store);
    if (result.status === "error") process.exitCode = 2;
  });

program
  .command("serve")
  .description("Process epic children in dependency order")
  .argument("[epic]", "Epic key (default from config)")
  .option("--dry-run", "Print plan only")
  .option("--skip-done", "Skip issues already verified")
  .option("--only <keys>", "Comma-separated issue keys to include")
  .option("--exclude <keys>", "Comma-separated keys to skip (merged with config)")
  .option("--force", "Ignore blocker state")
  .option("--continue-on-error", "Keep serving after a failed course")
  .option("--skip-verify", "Skip verify commands after each agent")
  .action(
    async (
      epicArg: string | undefined,
      opts: {
        dryRun?: boolean;
        skipDone?: boolean;
        only?: string;
        exclude?: string;
        force?: boolean;
        continueOnError?: boolean;
        skipVerify?: boolean;
      },
      cmd: Command,
    ) => {
      await ensureAcli();
      const config = loadConfig(globalConfig(cmd));
      const epic = epicArg ?? config.epic;
      if (!epic) throw new Error("Epic key required");

      const store = stateStore();
      store.setEpic(epic);

      const exclude = defaultExclude(config);
      for (const k of parseKeyList(opts.exclude) ?? []) exclude.add(k);

      let issues = sortByDependencies(
        filterMenuIssues(await listEpicChildren(epic), {
          exclude,
          only: parseKeyList(opts.only),
        }),
      );

      console.log(`Menu for epic ${epic} (${issues.length} courses)\n`);
      let failures = 0;

      for (const issue of issues) {
        if (opts.skipDone && store.isVerified(issue.key)) {
          console.log(`skip ${issue.key} (verified)`);
          continue;
        }
        if (!opts.force && !opts.dryRun) {
          const gate = store.canProcess(issue.key, issue.parsed.blockedBy);
          if (!gate.ok) {
            console.log(`hold ${issue.key}: ${gate.reason}`);
            continue;
          }
        }

        if (opts.dryRun) {
          await processIssue(issue, config, store, apiKey(), { dryRun: true });
          continue;
        }

        const result = await processIssue(issue, config, store, apiKey(), {
          skipVerify: opts.skipVerify,
        });
        if (result.status === "error") {
          failures += 1;
          console.error(`✗ ${issue.key} failed`);
          if (!opts.continueOnError) {
            process.exitCode = 2;
            break;
          }
        }
      }

      if (failures > 0 && opts.continueOnError) {
        console.error(`\n${failures} course(s) failed — see: npm run dev -- status`);
        process.exitCode = 2;
      }
    },
  );

program.parseAsync(process.argv).catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
