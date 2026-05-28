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

const mainProgram = Effect.gen(function* () {
  const argv = process.argv.slice(2);
  const parsed = parseTopLevelArgv(argv);

  if (parsed.mode === "meal") {
    yield* runMealArgv(parsed.epic, parsed.rest, parsed.configPath);
    return;
  }

  if (argv.length === 0) {
    program.outputHelp();
    return;
  }

  yield* Effect.tryPromise({
    try: () => program.parseAsync(parsed.rest, { from: "user" }),
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

NodeRuntime.runMain(
  mainProgram.pipe(
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
