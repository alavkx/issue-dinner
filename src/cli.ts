#!/usr/bin/env node
import { resolve } from "node:path";
import { Command } from "commander";
import { processIssue, sortByDependencies } from "./agent/runner.js";
import { loadConfig } from "./config.js";
import { ensureAcli, fetchIssue, listEpicChildren } from "./jira/acli.js";
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

program
  .command("list")
  .description("List child stories under an epic")
  .argument("[epic]", "Epic key (default from config)")
  .action(async (epicArg: string | undefined, _opts: unknown, cmd: Command) => {
    await ensureAcli();
    const config = loadConfig(globalConfig(cmd));
    const epic = epicArg ?? config.epic;
    if (!epic) throw new Error("Epic key required (arg or config.epic)");

    const issues = await listEpicChildren(epic);
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
      console.log(`${issue.key}  ${issue.status}${run}  ${issue.summary}${blockers}`);
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
      const issues = await listEpicChildren(epic);
      for (const issue of issues) {
        const rec = store.get(issue.key);
        const st = rec?.status ?? "pending";
        console.log(`${issue.key}  ${st.padEnd(10)}  ${issue.summary}`);
        if (rec?.agentId) console.log(`         agent=${rec.agentId} run=${rec.runId ?? "?"}`);
        if (rec?.error) console.log(`         error: ${rec.error.slice(0, 120)}`);
      }
      return;
    }

    for (const rec of store.list()) {
      console.log(`${rec.issueKey}  ${rec.status}  ${rec.summary}`);
    }
  });

program
  .command("cook")
  .description("Run a Cursor agent for one issue")
  .argument("<key>", "Issue key e.g. CPD-636")
  .option("--dry-run", "Print prompt without calling the SDK")
  .option("--no-stream", "Wait without streaming assistant text")
  .option("--resume <agentId>", "Resume a previous agent")
  .option("--force", "Run even if blockers are not finished locally")
  .action(
    async (
      key: string,
      opts: {
        dryRun?: boolean;
        noStream?: boolean;
        resume?: string;
        force?: boolean;
      },
      cmd: Command,
    ) => {
      await ensureAcli();
      if (!opts.dryRun && !commandExists("cursor")) {
        console.warn("Warning: `cursor` CLI not found on PATH; local SDK may still work.");
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
      });

      if (result.status === "error") {
        process.exitCode = 2;
      }
    },
  );

program
  .command("serve")
  .description("Process epic children in dependency order")
  .argument("[epic]", "Epic key (default from config)")
  .option("--dry-run", "Print plan only")
  .option("--skip-done", "Skip issues marked finished in .state")
  .option("--only <keys>", "Comma-separated issue keys to include")
  .option("--force", "Ignore blocker state")
  .action(
    async (
      epicArg: string | undefined,
      opts: {
        dryRun?: boolean;
        skipDone?: boolean;
        only?: string;
        force?: boolean;
      },
      cmd: Command,
    ) => {
      await ensureAcli();
      const config = loadConfig(globalConfig(cmd));
      const epic = epicArg ?? config.epic;
      if (!epic) throw new Error("Epic key required");

      const store = stateStore();
      store.setEpic(epic);

      let issues = sortByDependencies(await listEpicChildren(epic));
      if (opts.only) {
        const allow = new Set(opts.only.split(",").map((k) => k.trim()));
        issues = issues.filter((i) => allow.has(i.key));
      }

      console.log(`Menu for epic ${epic} (${issues.length} courses)\n`);
      for (const issue of issues) {
        const rec = store.get(issue.key);
        if (opts.skipDone && rec?.status === "finished") {
          console.log(`skip ${issue.key} (done)`);
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

        const result = await processIssue(issue, config, store, apiKey());
        if (result.status === "error") {
          console.error(`Stopped: ${issue.key} failed`);
          process.exitCode = 2;
          break;
        }
      }
    },
  );

program.parseAsync(process.argv).catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
