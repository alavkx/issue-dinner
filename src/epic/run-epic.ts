import * as FileSystem from "@effect/platform/FileSystem";
import * as Effect from "effect/Effect";
import {
  processIssue,
  sortByDependencies,
  verifyIssue,
} from "../agent/runner.js";
import { cursorApiKey } from "../env.js";
import { ConfigNotFound, type MissingCursorApiKey, type TmuxNotFound } from "../effect/errors.js";
import {
  assertPreflight,
  formatPreflightReport,
  runPreflight,
} from "../doctor/preflight.js";
import { buildLaunchShellCommand, launchInTmux } from "../launch/tmux.js";
import { findConfigPath } from "../config.js";
import { ensureAcli, fetchIssue, listEpicChildren } from "../jira/acli.js";
import { PlatformLive } from "../effect/layers.js";
import {
  resolveCliExecutable,
  stateStoreLayerForEpic,
  StateStore,
} from "../paths.js";
import { openServeLogger, type ServeLogger } from "../serve/log.js";
import type { ServeHaltInfo } from "../serve/failures.js";
import { storyOrderBlocks } from "../serve/story-order-gate.js";
import { printServeSummary } from "../serve/summary.js";
import { ensureWorkspacesCleanForIssue } from "../serve/workspace-gate.js";
import { formatAgentError } from "../agent/sdk-errors.js";
import { setServeShutdownHandler } from "../runtime/guards.js";
import { resolveProjectRoot } from "../runtime/project-root.js";
import {
  isSelfHealEnabled,
} from "../runtime/self-heal-flags.js";
import {
  NO_WATCH_RESTART_ON_CRASH_FLAG,
  WATCH_FLAG,
  WATCH_RESTART_ON_CRASH_FLAG,
} from "../runtime/watchdog.js";
import { isWatchChild } from "../runtime/relaunch.js";
import { isStayAwakeEnabled, startStayAwake } from "../runtime/stay-awake.js";
import type { SelfHealBuildPort } from "../self-heal/heal-build.js";
import {
  formatContributeReminder,
  listPendingContributions,
  type SelfHealGitPort,
} from "../self-heal/contribute.js";
import { syncDurableHealsToPackage } from "../self-heal/durable-patches.js";
import {
  clearHealResume,
  loadHealResume,
} from "../self-heal/heal-resume.js";
import { reviewAndContributeHeals } from "../self-heal/review-agent.js";
import { runCommand } from "../util/exec.js";
import * as out from "../ui/out.js";
import { filterEpicStories, parseKeyList } from "../serve/filter.js";
import { createGraphiteStackPort } from "../stack/graphite-runner.js";
import { prepEpicStack } from "../stack/prep.js";
import { buildEpicStackPlans } from "../stack/plan.js";
import { storyBranchName } from "../stack/names.js";
import { commandExists, shellQuote } from "../util/exec.js";
import { buildServeInvocation } from "./serve-invocation.js";
import { assertEpicCommand } from "./parse-argv.js";
import { createEpicRun, mergeExclude, type EpicRun } from "./epic-run.js";
import type { JiraIssue } from "../jira/acli.js";
import type * as CommandExecutor from "@effect/platform/CommandExecutor";

function flagValue(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i >= 0) return args[i + 1];
  return undefined;
}

function hasFlag(args: string[], name: string): boolean {
  return args.includes(name);
}

const listEpicStories = (
  run: EpicRun,
  excludeCsv?: string,
): Effect.Effect<JiraIssue[], unknown, CommandExecutor.CommandExecutor> =>
  Effect.gen(function* () {
    const children = yield* listEpicChildren(run.epic);
    return filterEpicStories(children, {
      exclude: mergeExclude(run, excludeCsv),
    });
  });

const runEpicPreflight = (
  run: EpicRun,
  stories: JiraIssue[],
  options: {
    requireApiKey?: boolean;
    checkGraphite?: boolean;
    checkTmux?: boolean;
    validateVerify?: boolean;
  },
): Effect.Effect<
  void,
  import("@effect/platform/Error").PlatformError,
  StateStore | CommandExecutor.CommandExecutor | FileSystem.FileSystem
> =>
  Effect.gen(function* () {
    const report = yield* runPreflight({
      config: run.machine,
      stack: run.stack,
      epicStories: stories,
      ...options,
    });
    console.log(formatPreflightReport(report));
    console.log("");
    assertPreflight(report);
  });

const printDryRunPlan = (
  run: EpicRun,
  issues: JiraIssue[],
): Effect.Effect<void, never, StateStore> =>
  Effect.gen(function* () {
    const store = yield* StateStore;
    console.log(`Run plan for ${run.epic} (${issues.length} stories):\n`);
    for (const issue of sortByDependencies(issues)) {
      const branch = storyBranchName(run.stack.prefix, issue.key);
      const gate = yield* store.canProcess(
        issue.key,
        issue.parsed.blockedBy,
      );
      const rec = yield* store.get(issue.key);
      const skip = (yield* store.isVerified(issue.key))
        ? "skip (verified)"
        : undefined;
      const hold = !gate.ok ? `hold: ${gate.reason}` : undefined;
      const state = rec?.status ? `[${rec.status}]` : "";
      console.log(
        `  ${issue.key}  ${branch}  ${skip ?? hold ?? state ?? "would run"}`,
      );
    }
    console.log("");
  });

const runEpicWithStore = (
  run: EpicRun,
  argv: string[],
  configPath?: string,
): Effect.Effect<
  void,
  MissingCursorApiKey | unknown,
  StateStore | CommandExecutor.CommandExecutor | FileSystem.FileSystem | SelfHealBuildPort | SelfHealGitPort
> =>
  Effect.gen(function* () {
    const store = yield* StateStore;
    const command = assertEpicCommand(argv[0]);
    const args = argv.slice(1);

    if (
      command !== "launch" &&
      isStayAwakeEnabled(args) &&
      !isWatchChild()
    ) {
      yield* startStayAwake();
    }

    switch (command) {
      case "list": {
        yield* ensureAcli;
        const issues = yield* listEpicStories(run, flagValue(args, "--exclude"));
        console.log(`Epic ${run.epic} — ${issues.length} stories\n`);
        for (const issue of issues) {
          const rec = yield* store.get(issue.key);
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
        yield* ensureAcli;
        const issues = yield* listEpicStories(run);
        const verbose = hasFlag(args, "--verbose");
        for (const issue of issues) {
          const rec = yield* store.get(issue.key);
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
            console.log(
              `         agent=${rec.agentId} run=${rec.runId ?? "?"}`,
            );
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
        if (!(yield* commandExists("gt"))) {
          throw new Error("gt (Graphite) is not on PATH");
        }
        yield* ensureAcli;
        const issues = yield* listEpicStories(run, flagValue(args, "--exclude"));
        if (hasFlag(args, "--dry-run")) {
          const plans = buildEpicStackPlans(
            issues,
            run.machine,
            run.stack.base,
            run.stack.prefix,
          );
          console.log(
            `Would prep ${issues.length} stories for ${run.epic} (${run.stack.prefix}/*)\n`,
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
          yield* runEpicPreflight(run, issues, {
            checkGraphite: true,
            checkTmux: false,
            validateVerify: false,
          });
        }
        const summary = yield* prepEpicStack(
          issues,
          run.machine,
          run.stack,
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
        yield* ensureAcli;
        const selfHeal = isSelfHealEnabled(args);
        const toolRoot = selfHeal ? yield* resolveProjectRoot() : undefined;
        const serveArgv: string[] = [run.epic];
        if (configPath) serveArgv.push("-c", configPath);
        serveArgv.push("serve", ...args);
        const exclude = mergeExclude(run, flagValue(args, "--exclude"));
        const children = yield* listEpicChildren(run.epic);
        const issues = sortByDependencies(
          filterEpicStories(children, {
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
          yield* runEpicPreflight(run, issues, {
            checkGraphite: false,
            checkTmux: false,
          });
        } else if (dryRun) {
          const report = yield* runPreflight({
            config: run.machine,
            stack: run.stack,
            epicStories: issues,
            checkGraphite: false,
            checkTmux: false,
          });
          console.log(formatPreflightReport(report));
          console.log("");
          yield* printDryRunPlan(run, issues);
        }

        const recoverStaleEffect = store.recoverStaleRunning().pipe(
          Effect.tap((keys) =>
            Effect.sync(() => {
              if (keys.length > 0) {
                console.log(`Recovered stale running: ${keys.join(", ")}\n`);
              }
            }),
          ),
        );

        const recoverStaleOutsideFiber = (): void => {
          void Effect.runPromise(
            recoverStaleEffect.pipe(
              Effect.provide(stateStoreLayerForEpic(run.epic)),
              Effect.provide(PlatformLive),
            ),
          );
        };

        yield* recoverStaleEffect;

        setServeShutdownHandler(recoverStaleOutsideFiber);

        let sigintHandler: (() => void) | undefined;
        if (!dryRun) {
          sigintHandler = () => {
            out.warn("Interrupted — marking in-flight stories and exiting");
            void Effect.runPromise(
              recoverStaleEffect.pipe(
                Effect.provide(stateStoreLayerForEpic(run.epic)),
                Effect.provide(PlatformLive),
              ),
            ).finally(() => {
              process.exitCode = 130;
              process.exit(130);
            });
          };
          process.once("SIGINT", sigintHandler);
        }

        let logger: ServeLogger | undefined;
        const serveStartedAt = new Date().toISOString();
        if (!dryRun) {
          yield* store.setEpic(run.epic);
          logger = yield* openServeLogger(run.epic);
          logger.attach();
          console.log(`Logging to ${logger.logPath}\n`);
        }

        out.banner(`Epic run — ${run.epic} (${issues.length} stories)`);
        if (selfHeal) {
          out.info(`Self-heal active (${toolRoot})`);
        }

        if (selfHeal && !dryRun && toolRoot) {
          const synced = yield* syncDurableHealsToPackage(toolRoot).pipe(
            Effect.catchAll(() => Effect.succeed([] as string[])),
          );
          if (synced.length > 0) {
            out.info(`Synced ${synced.length} durable heal(s) into package`);
            yield* runCommand("npm", ["run", "build"], { cwd: toolRoot }).pipe(
              Effect.catchAll((err) =>
                Effect.sync(() => {
                  out.warn(`heal sync build: ${String(err)}`);
                }),
              ),
            );
          }
        }

        let failures = 0;
        const held: Array<{ key: string; reason: string }> = [];
        const skipped: string[] = [];
        const processedThisSession: string[] = [];
        const skippedSet = new Set<string>();
        let halt: ServeHaltInfo | undefined;

        try {
          for (let storyIndex = 0; storyIndex < issues.length; storyIndex++) {
            const issue = issues[storyIndex]!;
            if (skipDone && (yield* store.isVerified(issue.key))) {
              out.skipStory(issue.key, "verified");
              skipped.push(issue.key);
              skippedSet.add(issue.key);
              continue;
            }
            if (!force && !dryRun) {
              const orderGate = yield* storyOrderBlocks(
                issues,
                storyIndex,
                skippedSet,
              );
              if (!orderGate.ok) {
                out.holdStory(issue.key, orderGate.reason ?? "blocked");
                held.push({
                  key: issue.key,
                  reason: orderGate.reason ?? "blocked",
                });
                continue;
              }
            }
            if (!force && !dryRun) {
              const gate = yield* store.canProcess(
                issue.key,
                issue.parsed.blockedBy,
              );
              if (!gate.ok) {
                out.holdStory(issue.key, gate.reason ?? "blocked");
                held.push({
                  key: issue.key,
                  reason: gate.reason ?? "blocked",
                });
                continue;
              }
            } else if (!force && dryRun) {
              const gate = yield* store.canProcess(
                issue.key,
                issue.parsed.blockedBy,
              );
              if (!gate.ok) {
                console.log(`[dry-run] hold ${issue.key}: ${gate.reason}`);
                held.push({
                  key: issue.key,
                  reason: gate.reason ?? "blocked",
                });
                continue;
              }
            }

            if (dryRun) {
              const apiKey = yield* cursorApiKey;
              yield* processIssue(issue, run.machine, apiKey, {
                dryRun: true,
                stack: run.stack,
              });
              continue;
            }

            const prior = yield* store.get(issue.key);
            if (prior?.status === "agent_complete" && !skipVerify) {
              out.info(
                `${issue.key}: retrying verify (previous agent_complete)`,
              );
              const retry = yield* verifyIssue(issue, run.machine);
              if (retry.status === "verified") {
                continue;
              }
            }

            const apiKey = yield* cursorApiKey;

            const healResume =
              selfHeal && !dryRun ? yield* loadHealResume() : undefined;
            const isPostHealResume =
              healResume &&
              healResume.epic === run.epic &&
              healResume.issueKey === issue.key &&
              healResume.postHealResume;

            if (isPostHealResume) {
              yield* clearHealResume();
              out.info(`${issue.key}: resuming after issue-dinner self-heal`);
            }

            processedThisSession.push(issue.key);

            const result = yield* processIssue(
              issue,
              run.machine,
              apiKey,
              {
                skipVerify,
                stack: run.stack,
                epic: run.epic,
                selfHeal,
                toolRoot,
                serveHeal: {
                  serveArgv,
                  storyIndex,
                  epic: run.epic,
                  configPath,
                },
                ...(isPostHealResume
                  ? {
                      resumeAgentId: healResume!.storyAgentId,
                      postHealResume: {
                        fixSummary:
                          healResume!.fixSummary ??
                          "issue-dinner source was patched.",
                      },
                    }
                  : {}),
              },
            ).pipe(
              Effect.catchAll((err) =>
                Effect.gen(function* () {
                  const message = formatAgentError(err);
                  yield* store.upsert({
                    issueKey: issue.key,
                    summary: issue.summary,
                    status: "error",
                    error: message,
                    finishedAt: new Date().toISOString(),
                  });
                  return {
                    issueKey: issue.key,
                    status: "error" as const,
                    error: message,
                  };
                }),
              ),
            );

            if (result.status === "error") {
              failures += 1;
              halt = {
                issueKey: issue.key,
                summary: issue.summary,
                reason: result.error ?? "story failed",
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

            const clean = yield* ensureWorkspacesCleanForIssue(
              run.machine,
              issue,
              { label: "before next story" },
            );
            if (!clean.ok) {
              failures += 1;
              const reason =
                clean.detail ??
                "dirty workspace after story — cannot advance stack";
              halt = {
                issueKey: issue.key,
                summary: issue.summary,
                reason,
              };
              out.error(
                `${issue.key} left repo dirty — halting run (fix git, then re-serve)`,
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
            yield* recoverStaleEffect;
            if (selfHeal && toolRoot) {
              const pending = yield* listPendingContributions(toolRoot);
              const reminder = formatContributeReminder(pending);
              if (reminder) out.info(reminder);

              if (
                !hasFlag(args, "--no-heal-review") &&
                pending.length > 0
              ) {
                const apiKey = yield* cursorApiKey;
                yield* reviewAndContributeHeals({
                  toolRoot,
                  config: run.machine,
                  apiKey,
                }).pipe(
                  Effect.catchAll((err) =>
                    Effect.sync(() => {
                      out.warn(`heal review: ${String(err)}`);
                    }),
                  ),
                );
              }
            }

            const pendingHealContributions =
              selfHeal && toolRoot
                ? yield* listPendingContributions(toolRoot)
                : undefined;

            yield* printServeSummary({
              epic: run.epic,
              stack: run.stack,
              issues,
              held,
              skipped,
              logPath: logger?.logPath,
              halt,
              session: {
                serveStartedAt,
                selfHeal,
                processedThisSession,
                skippedAlreadyVerified: skipped,
                pendingHealContributions,
              },
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
        const resolvedConfigPath = yield* findConfigPath(configPath);
        const cliExecutable = yield* resolveCliExecutable();
        const exclude = flagValue(args, "--exclude");
        const dryRun = hasFlag(args, "--dry-run");
        const noPrep = hasFlag(args, "--no-prep");
        const skipPreflight = hasFlag(args, "--skip-preflight");

        yield* ensureAcli;
        const issues = yield* listEpicStories(run, exclude);

        if (!skipPreflight) {
          yield* runEpicPreflight(run, issues, {
            checkGraphite: !noPrep,
            checkTmux: !dryRun,
          });
        }

        if (!noPrep && !dryRun) {
          if (!(yield* commandExists("gt"))) {
            throw new Error(
              "gt (Graphite) is not on PATH — use --no-prep to skip",
            );
          }
          console.log(`Preparing Graphite stacks for ${run.epic}…`);
          yield* prepEpicStack(
            issues,
            run.machine,
            run.stack,
            createGraphiteStackPort(),
          );
        } else if (dryRun && !noPrep) {
          const plans = buildEpicStackPlans(
            issues,
            run.machine,
            run.stack.base,
            run.stack.prefix,
          );
          console.log(`Would prep ${issues.length} stories:\n`);
          for (const [workspaceKey, steps] of plans) {
            for (const step of steps) {
              console.log(`  ${workspaceKey}  ${step.branch}`);
            }
          }
          console.log("");
        }

        const inner = buildServeInvocation(
          cliExecutable,
          run.epic,
          resolvedConfigPath,
          {
          continueOnError: hasFlag(args, "--continue-on-error"),
          skipDone: !hasFlag(args, "--no-skip-done"),
          exclude,
          only: flagValue(args, "--only"),
          force: hasFlag(args, "--force"),
          skipVerify: hasFlag(args, "--skip-verify"),
          skipPreflight: true,
          dryRun,
          selfHeal: isSelfHealEnabled(args),
          watch: hasFlag(args, WATCH_FLAG),
          watchRestartOnCrash:
            !hasFlag(args, NO_WATCH_RESTART_ON_CRASH_FLAG) &&
            (hasFlag(args, WATCH_RESTART_ON_CRASH_FLAG) ||
              hasFlag(args, WATCH_FLAG)),
          stayAwake: isStayAwakeEnabled(args),
        },
        );

        const apiKey = dryRun
          ? (process.env.ISSUE_DINNER_CURSOR_API_KEY?.trim() ?? "")
          : yield* cursorApiKey;

        if (dryRun) {
          yield* printDryRunPlan(run, issues);
          const session = flagValue(args, "--session") ?? run.epic;
          const detach = hasFlag(args, "--detach");
          console.log(
            `# tmux session: ${session}${detach ? " (detached)" : " (attached)"}`,
          );
          console.log(buildLaunchShellCommand(inner, apiKey));
          return;
        }

        const launchApiKey = yield* cursorApiKey;
        yield* launchInTmux({
          session: flagValue(args, "--session") ?? run.epic,
          innerCommand: inner,
          apiKey: launchApiKey,
          epic: run.epic,
          detach: hasFlag(args, "--detach"),
        });
        return;
      }
      case "run": {
        const key = args[0];
        if (!key || key.startsWith("-")) {
          throw new Error(
            "run requires a story key: issue-dinner CPD-635 run CPD-636",
          );
        }
        const runArgs = args.slice(1);
        const selfHeal = isSelfHealEnabled(runArgs);
        const toolRoot = selfHeal ? yield* resolveProjectRoot() : undefined;
        yield* ensureAcli;
        if (
          !hasFlag(runArgs, "--dry-run") &&
          !(yield* commandExists("cursor"))
        ) {
          console.warn(
            "Warning: `cursor` CLI not found on PATH; local SDK agents require it.",
          );
        }
        const issue = yield* fetchIssue(key);
        const dryRun = hasFlag(runArgs, "--dry-run");
        if (!hasFlag(runArgs, "--force") && !dryRun) {
          const gate = yield* store.canProcess(key, issue.parsed.blockedBy);
          if (!gate.ok) throw new Error(gate.reason);
        }
        const apiKey = yield* cursorApiKey;
        const result = yield* processIssue(issue, run.machine, apiKey, {
          dryRun,
          stream: !hasFlag(runArgs, "--no-stream"),
          resumeAgentId: flagValue(runArgs, "--resume"),
          skipVerify: hasFlag(runArgs, "--skip-verify"),
          stack: run.stack,
          selfHeal,
          toolRoot,
        });
        if (result.status === "error") process.exitCode = 2;
        if (result.status === "agent_complete") process.exitCode = 2;
        return;
      }
      default:
        throw new Error(`Unhandled run command: ${command}`);
    }
  });

export const runEpicArgv = (
  epic: string,
  argv: string[],
  configPath?: string,
): Effect.Effect<
  void,
  ConfigNotFound | MissingCursorApiKey | TmuxNotFound | unknown,
  FileSystem.FileSystem | CommandExecutor.CommandExecutor | SelfHealBuildPort | SelfHealGitPort
> =>
  Effect.gen(function* () {
    const run = yield* createEpicRun(epic, { configPath });
    yield* runEpicWithStore(run, argv, configPath).pipe(
      Effect.provide(stateStoreLayerForEpic(run.epic, run.blockerPolicy)),
    );
  });
