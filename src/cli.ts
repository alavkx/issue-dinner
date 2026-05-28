#!/usr/bin/env node
import { installProcessGuards } from "./runtime/guards.js";
import { Command, CommanderError } from "commander";
import { NodeRuntime } from "@effect/platform-node";
import * as Effect from "effect/Effect";
import { verifyIssue } from "./agent/runner.js";
import { loadMachineConfig } from "./config.js";
import { ConfigNotFound, MissingCursorApiKey, TmuxNotFound } from "./effect/errors.js";
import { PlatformLive } from "./effect/layers.js";
import { parseTopLevelArgv } from "./epic/parse-argv.js";
import { runMealArgv } from "./epic/run-meal.js";
import { ensureAcli, fetchIssue } from "./jira/acli.js";
import { stateStoreLayer } from "./paths.js";
import {
  formatKitchenStatus,
  getKitchenStatus,
  processKitchenInbox,
} from "./self-heal/kitchen.js";
import { contributeAppliedPatches } from "./self-heal/contribute.js";
import { runWatchdog, stripWatchArgv } from "./runtime/watchdog.js";

installProcessGuards();

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

const showIssue = (key: string, configPath?: string) =>
  Effect.gen(function* () {
    yield* ensureAcli;
    yield* loadMachineConfig(configPath);
    const issue = yield* fetchIssue(key);
    console.log(`${issue.key}: ${issue.summary} (${issue.status})\n`);
    console.log(issue.description);
    console.log("\n--- parsed ---");
    console.log(JSON.stringify(issue.parsed, null, 2));
  });

const verifyCommand = (key: string, configPath?: string) =>
  Effect.gen(function* () {
    const machine = yield* loadMachineConfig(configPath);
    yield* ensureAcli;
    const issue = yield* fetchIssue(key);
    const result = yield* verifyIssue(issue, machine);
    if (result.status === "error") process.exitCode = 2;
  }).pipe(Effect.provide(stateStoreLayer()));

program
  .command("show")
  .description("Print parsed issue body (no epic context required)")
  .argument("<key>", "Issue key e.g. CPD-636")
  .action((key: string, _opts: unknown, cmd: Command) => {
    void Effect.runPromise(
      showIssue(key, globalConfig(cmd)).pipe(
        Effect.provide(PlatformLive),
        Effect.catchAll((err) => {
          if (err instanceof ConfigNotFound) {
            console.error(err.message);
            process.exitCode = 1;
            return Effect.void;
          }
          return Effect.fail(err);
        }),
        Effect.asVoid,
      ),
    );
  });

program
  .command("verify")
  .description("Re-run verify commands for one issue (uses install config)")
  .argument("<key>", "Issue key")
  .action((key: string, _opts: unknown, cmd: Command) => {
    void Effect.runPromise(
      verifyCommand(key, globalConfig(cmd)).pipe(
        Effect.provide(PlatformLive),
        Effect.catchAll((err) => {
          if (err instanceof ConfigNotFound) {
            console.error(err.message);
            process.exitCode = 1;
            return Effect.void;
          }
          return Effect.fail(err);
        }),
        Effect.asVoid,
      ),
    );
  });

const kitchen = program
  .command("kitchen")
  .description("Self-heal queue for patching issue-dinner during serve runs");

kitchen
  .command("status")
  .description("List inbox, applied, and failed kitchen patches")
  .action(() => {
    void Effect.runPromise(
      Effect.gen(function* () {
        const status = yield* getKitchenStatus();
        console.log(formatKitchenStatus(status));
      }).pipe(Effect.provide(PlatformLive)),
    );
  });

kitchen
  .command("apply")
  .description("Apply inbox patches (typecheck + build)")
  .option("--dry-run", "Validate manifests without writing files")
  .action((opts: { dryRun?: boolean }) => {
    void Effect.runPromise(
      processKitchenInbox({ dryRun: opts.dryRun }).pipe(
        Effect.provide(PlatformLive),
        Effect.tap((result) =>
          Effect.sync(() => {
            console.log(
              `Applied: ${result.applied.join(", ") || "(none)"}; failed: ${result.failed.join(", ") || "(none)"}`,
            );
          }),
        ),
      ),
    );
  });

kitchen
  .command("contribute")
  .description("Open PRs for applied kitchen patches against main")
  .option("--dry-run", "Print contribution plan without git/gh changes")
  .option("--patch <id>", "Contribute a single patch id")
  .option("--base <branch>", "Target base branch (default: main or ISSUE_DINNER_CONTRIBUTE_BASE)")
  .option("--remote <name>", "Git remote to push (default: origin)")
  .action((opts: { dryRun?: boolean; patch?: string; base?: string; remote?: string }) => {
    void Effect.runPromise(
      contributeAppliedPatches({
        dryRun: opts.dryRun,
        patchId: opts.patch,
        baseBranch: opts.base,
        remote: opts.remote,
      }).pipe(
        Effect.provide(PlatformLive),
        Effect.tap((result) =>
          Effect.sync(() => {
            console.log(
              `Contributed: ${result.contributed.join(", ") || "(none)"}; skipped: ${result.skipped.join(", ") || "(none)"}; failed: ${result.failed.map((f) => f.patchId).join(", ") || "(none)"}`,
            );
          }),
        ),
      ),
    );
  });

const rawArgv = process.argv.slice(2);
const strippedWatch = stripWatchArgv(rawArgv);

const mainProgram = Effect.gen(function* () {
  const parsed = parseTopLevelArgv([...strippedWatch.argv]);

  if (parsed.mode === "meal") {
    yield* runMealArgv(parsed.epic, [...parsed.rest], parsed.configPath);
    return;
  }

  if (strippedWatch.argv.length === 0) {
    program.outputHelp();
    return;
  }

  yield* Effect.tryPromise({
    try: () => program.parseAsync(strippedWatch.argv, { from: "user" }),
    catch: (err) => err,
  }).pipe(
    Effect.catchAll((err) => {
      if (err instanceof CommanderError && err.code === "commander.help") {
        return Effect.void;
      }
      return Effect.fail(err);
    }),
  );
});

const runMain = strippedWatch.watch
  ? runWatchdog(strippedWatch.argv, {
      restartOnCrash: strippedWatch.restartOnCrash,
    })
  : mainProgram;

NodeRuntime.runMain(
  runMain.pipe(
    Effect.provide(PlatformLive),
    Effect.catchTags({
      ConfigNotFound: (e: ConfigNotFound) =>
        Effect.sync(() => {
          console.error(e.message);
          process.exitCode = 1;
        }),
      MissingCursorApiKey: (e: MissingCursorApiKey) =>
        Effect.sync(() => {
          console.error(e.message);
          process.exitCode = 1;
        }),
      TmuxNotFound: (e: TmuxNotFound) =>
        Effect.sync(() => {
          console.error(e.message);
          process.exitCode = 1;
        }),
    }),
  ),
);
