#!/usr/bin/env node
import { Command, CommanderError } from "commander";
import { verifyIssue } from "./agent/runner.js";
import { loadMachineConfig } from "./config.js";
import { parseTopLevelArgv } from "./epic/parse-argv.js";
import { runMealArgv } from "./epic/run-meal.js";
import { ensureAcli, fetchIssue } from "./jira/acli.js";
import { stateStore } from "./paths.js";

function globalConfig(cmd: Command): string | undefined {
  return cmd.optsWithGlobals().config as string | undefined;
}

const program = new Command();

program
  .name("issue-dinner")
  .description(
    "Eat a Jira epic (issue group): issue-dinner CPD-635 [list|prep|serve|launch|cook …]",
  )
  .option("-c, --config <path>", "Path to install config (workspaces, verify, …)")
  .showHelpAfterError();

program
  .command("show")
  .description("Print parsed issue body (no epic context required)")
  .argument("<key>", "Issue key e.g. CPD-636")
  .action(async (key: string, _opts: unknown, cmd: Command) => {
    await ensureAcli();
    loadMachineConfig(globalConfig(cmd));
    const issue = await fetchIssue(key);
    console.log(`${issue.key}: ${issue.summary} (${issue.status})\n`);
    console.log(issue.description);
    console.log("\n--- parsed ---");
    console.log(JSON.stringify(issue.parsed, null, 2));
  });

program
  .command("verify")
  .description("Re-run verify commands for one issue (uses install config)")
  .argument("<key>", "Issue key")
  .action(async (key: string, _opts: unknown, cmd: Command) => {
    const machine = loadMachineConfig(globalConfig(cmd));
    const store = stateStore();
    await ensureAcli();
    const issue = await fetchIssue(key);
    const result = await verifyIssue(issue, machine, store);
    if (result.status === "error") process.exitCode = 2;
  });

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const parsed = parseTopLevelArgv(argv);

  if (parsed.mode === "meal") {
    await runMealArgv(parsed.epic, parsed.rest, parsed.configPath);
    return;
  }

  if (argv.length === 0) {
    program.outputHelp();
    return;
  }

  try {
    await program.parseAsync(parsed.rest, { from: "user" });
  } catch (err) {
    if (err instanceof CommanderError && err.code === "commander.help") {
      return;
    }
    throw err;
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
