import { Agent, CursorAgentError } from "@cursor/sdk";
import type { DinnerConfig } from "../config.js";
import type { StackConfig } from "../stack/stack-config.js";
import {
  formatWorkspacesLabel,
  localAgentOptions,
  resolveIssueWorkspaces,
  type IssueWorkspaces,
} from "../config/workspaces.js";
import { CommandFailed } from "../effect/errors.js";
import { recoverDirtyWorkspaces } from "../git/recover-workspace.js";
import {
  commitCourseWip,
  gitCurrentBranch,
  gitIsDirty,
  type CommitResult,
} from "../git/workspace.js";
import type { JiraIssue } from "../jira/acli.js";
import { StateStore } from "../state/store.js";
import { resolveVerifyCommandsForIssue } from "../verify/resolve.js";
import {
  filterVerifyCommandsForServe,
  runVerifyCommands,
} from "../verify/runner.js";
import {
  agentPhaseSucceeded,
  parseHandoff,
  verificationIsStrongEnough,
} from "./handoff.js";
import { buildAgentPrompt } from "./prompt.js";
import { checkoutWithRecovery, runRecoveryAgent } from "./recovery.js";
import { drainRunStream } from "./stream-handler.js";
import {
  formatAgentError,
  isSdkCanceledError,
  safeDisposeAgent,
} from "./sdk-errors.js";
import { ensureWorkspacesCleanForIssue } from "../serve/workspace-gate.js";
import { Transcript } from "../serve/transcript.js";
import * as out from "../ui/out.js";
import * as Effect from "effect/Effect";

export interface ProcessOptions {
  dryRun?: boolean;
  stream?: boolean;
  resumeAgentId?: string;
  skipVerify?: boolean;
  skipCommit?: boolean;
  stack?: StackConfig;
  epic?: string;
}

export interface ProcessResult {
  issueKey: string;
  status: "verified" | "agent_complete" | "error" | "cancelled" | "dry-run";
  agentId?: string;
  runId?: string;
  result?: string;
  error?: string;
}

function stateWorkspaceFields(roots: IssueWorkspaces): {
  workspace: string;
  cwd: string;
} {
  return {
    workspace: roots.keys.join(","),
    cwd: roots.cwds.join(" | "),
  };
}

const recordBranches = (
  roots: IssueWorkspaces,
): Effect.Effect<
  Record<string, string>,
  import("@effect/platform/Error").PlatformError | CommandFailed,
  import("@effect/platform/CommandExecutor").CommandExecutor
> =>
  Effect.gen(function* () {
    const branches: Record<string, string> = {};
    for (let i = 0; i < roots.keys.length; i++) {
      branches[roots.keys[i]!] = yield* gitCurrentBranch(roots.cwds[i]!);
    }
    return branches;
  });

export const runVerifyPhase = (
  issue: JiraIssue,
  config: DinnerConfig,
  roots: IssueWorkspaces,
  options: { gate?: "inner" | "full" } = {},
): Effect.Effect<
  { ok: boolean; error?: string; output: string },
  never,
  import("@effect/platform/CommandExecutor").CommandExecutor
> =>
  Effect.gen(function* () {
    if (!config.requireVerify) {
      return { ok: true, output: "(verify disabled in config)" };
    }

    const gate =
      options.gate === "full"
        ? "full"
        : config.serveVerifyGate === "none"
          ? "none"
          : config.serveVerifyGate;

    const all = resolveVerifyCommandsForIssue(config, issue.key, roots.keys);
    const commands = filterVerifyCommandsForServe(all, gate);
    if (commands.length === 0 && all.length > 0 && gate === "inner") {
      return {
        ok: true,
        output: `(inner verify gate: skipped ${all.length} outer-tier command(s))`,
      };
    }
    if (commands.length === 0 && gate === "inner") {
      return {
        ok: true,
        output:
          all.length > 0
            ? `(quick checks skipped — only slow tests are configured for ${issue.key})`
            : `(no automated quick checks for ${issue.key} — continuing serve)`,
      };
    }
    if (commands.length === 0) {
      return {
        ok: false,
        output: "",
        error: `No verify commands for ${issue.key} (roots: ${roots.keys.join(", ")})`,
      };
    }

    out.phase(
      "verify",
      `${issue.key} — ${commands.length} command(s), ${roots.keys.length} root(s)`,
    );
    const result = yield* runVerifyCommands(commands);
    if (!result.ok) {
      const detail = result.failures.map((f) => f.name).join(", ");
      return {
        ok: false,
        output: result.output,
        error: `Verify failed: ${detail}`,
      };
    }
    return { ok: true, output: result.output };
  });

export const verifyIssue = (
  issue: JiraIssue,
  config: DinnerConfig,
): Effect.Effect<
  ProcessResult,
  unknown,
  StateStore | import("@effect/platform/CommandExecutor").CommandExecutor
> =>
  Effect.gen(function* () {
    const store = yield* StateStore;
    const roots = resolveIssueWorkspaces(
      config,
      issue.key,
      issue.description,
      issue.summary,
    );
    const ws = stateWorkspaceFields(roots);
    const rec = yield* store.get(issue.key);

    const verify = yield* runVerifyPhase(issue, config, roots);
    if (!verify.ok) {
      yield* store.upsert({
        issueKey: issue.key,
        summary: issue.summary,
        status: rec?.handoffStatus ? "agent_complete" : "error",
        ...ws,
        verifyError: verify.error,
        error: rec?.handoffStatus ? undefined : verify.error,
        verifyOutput: verify.output.slice(0, 2000),
        finishedAt: new Date().toISOString(),
        branches: rec?.branches,
        commits: rec?.commits,
        handoffStatus: rec?.handoffStatus,
        handoffVerification: rec?.handoffVerification,
      });
      return {
        issueKey: issue.key,
        status: rec?.handoffStatus ? "agent_complete" : "error",
        error: verify.error,
      };
    }

    yield* store.upsert({
      issueKey: issue.key,
      summary: issue.summary,
      status: "verified",
      ...ws,
      agentId: rec?.agentId,
      runId: rec?.runId,
      handoffStatus: rec?.handoffStatus,
      handoffVerification: rec?.handoffVerification,
      verifyOutput: verify.output.slice(0, 2000),
      finishedAt: new Date().toISOString(),
      resultPreview: rec?.resultPreview,
      branches: rec?.branches,
      commits: rec?.commits,
    });

    out.success(`${issue.key} verified`);
    return { issueKey: issue.key, status: "verified" };
  });

export const processIssue = (
  issue: JiraIssue,
  config: DinnerConfig,
  apiKey: string,
  options: ProcessOptions = {},
): Effect.Effect<
  ProcessResult,
  unknown,
  StateStore | import("@effect/platform/CommandExecutor").CommandExecutor
> =>
  Effect.gen(function* () {
    const store = yield* StateStore;
    const roots = resolveIssueWorkspaces(
      config,
      issue.key,
      issue.description,
      issue.summary,
    );
    const ws = stateWorkspaceFields(roots);
    const prompt = buildAgentPrompt({ issue, roots, config });
    const transcript = options.epic
      ? new Transcript(options.epic, issue.key)
      : undefined;
    transcript?.appendLine(`Course start: ${issue.summary}`);

    let branches: Record<string, string> = {};
    if (options.stack && !options.dryRun) {
      const clean = yield* ensureWorkspacesCleanForIssue(config, issue, {
        label: "stack prep",
      });
      if (!clean.ok) {
        const msg = clean.detail ?? "workspace not clean for stack prep";
        yield* store.appendResolutionStep(issue.key, `Stack prep blocked: ${msg}`);
        yield* store.upsert({
          issueKey: issue.key,
          summary: issue.summary,
          status: "error",
          ...ws,
          finishedAt: new Date().toISOString(),
          error: msg,
          transcriptPath: transcript?.path,
        });
        out.error(`${issue.key}: ${msg}`);
        return { issueKey: issue.key, status: "error", error: msg };
      }

      const stackOutcome = yield* checkoutWithRecovery({
        issue,
        config,
        stack: options.stack,
        apiKey,
        transcript,
      }).pipe(
        Effect.match({
          onFailure: (err) => ({
            ok: false as const,
            message: err instanceof Error ? err.message : String(err),
          }),
          onSuccess: (actions) => ({ ok: true as const, actions }),
        }),
      );

      if (!stackOutcome.ok) {
        const message = stackOutcome.message;
        yield* store.appendResolutionStep(
          issue.key,
          `Stack prep failed: ${message.slice(0, 300)}`,
        );
        yield* store.upsert({
          issueKey: issue.key,
          summary: issue.summary,
          status: "error",
          ...ws,
          finishedAt: new Date().toISOString(),
          error: message,
          transcriptPath: transcript?.path,
        });
        out.error(`${issue.key}: stack prep failed — ${message}`);
        return { issueKey: issue.key, status: "error", error: message };
      }

      for (const row of stackOutcome.actions) {
        if (row.action === "noop") continue;
        out.info(`stack ${row.workspace}: ${row.action} → ${row.branch}`);
        transcript?.appendLine(
          `stack ${row.workspace}: ${row.action} → ${row.branch}`,
        );
      }
      branches = yield* recordBranches(roots);
    } else if (!options.dryRun) {
      branches = yield* recordBranches(roots);
    }

    if (options.dryRun) {
      console.log(`[dry-run] ${issue.key} → ${formatWorkspacesLabel(roots)}\n`);
      console.log(prompt.slice(0, 1200));
      console.log("\n… (truncated)\n");
      return { issueKey: issue.key, status: "dry-run" };
    }

    yield* store.upsert({
      issueKey: issue.key,
      summary: issue.summary,
      status: "running",
      ...ws,
      branches,
      transcriptPath: transcript?.path,
      startedAt: new Date().toISOString(),
    });

    out.courseHeader(issue.key, issue.summary, "running");
    out.info(formatWorkspacesLabel(roots));
    const local = localAgentOptions(config, roots.cwds);
    out.phase("agent", `local cwd=${JSON.stringify(local.cwd)}`);
    transcript?.appendLine(`agent local cwd=${JSON.stringify(local.cwd)}`);

    const agentResult = yield* Effect.gen(function* () {
      const agent = yield* Effect.tryPromise({
        try: () =>
          options.resumeAgentId
            ? Agent.resume(options.resumeAgentId, {
                apiKey,
                model: { id: config.model },
                local,
              })
            : Agent.create({
                apiKey,
                model: { id: config.model },
                local,
              }),
        catch: (err) => err,
      });

      return yield* Effect.gen(function* () {
        const run = yield* Effect.tryPromise({
          try: () => agent.send(prompt),
          catch: (err) => err,
        });
        out.phase("stream", `agentId=${agent.agentId} runId=${run.id}`);
        transcript?.appendLine(`agentId=${agent.agentId} runId=${run.id}`);

        let streamCanceled = false;
        if (options.stream !== false) {
          const sink = {
            writeStdout: (t: string) => process.stdout.write(t),
            writeStderr: (t: string) => process.stderr.write(t),
            transcript: (t: string) => transcript?.append(t),
          };
          const drain = yield* Effect.tryPromise({
            try: () => drainRunStream(run.stream(), sink),
            catch: (err) => err,
          });
          streamCanceled = drain.canceled;
        }

        let result;
        const waitOutcome = yield* Effect.tryPromise({
          try: () => run.wait(),
          catch: (err) => err,
        }).pipe(
          Effect.match({
            onFailure: (waitErr) => ({ ok: false as const, err: waitErr }),
            onSuccess: (value) => ({ ok: true as const, value }),
          }),
        );

        if (!waitOutcome.ok) {
          streamCanceled = true;
          const msg = formatAgentError(waitOutcome.err);
          yield* store.appendResolutionStep(
            issue.key,
            `Agent run error: ${msg.slice(0, 200)}`,
          );
          const recovery = yield* runRecoveryAgent({
            issue,
            config,
            roots,
            apiKey,
            kind: "agent_error",
            detail: msg,
            transcript,
            resumeAgentId: agent.agentId,
          });
          if (recovery.recovered && recovery.runId) {
            result = {
              id: recovery.runId,
              status: "finished" as const,
              result: recovery.resultText,
            };
          } else {
            yield* store.upsert({
              issueKey: issue.key,
              summary: issue.summary,
              status: "error",
              ...ws,
              branches,
              agentId: agent.agentId,
              finishedAt: new Date().toISOString(),
              error: msg,
              resultPreview: msg.slice(0, 500),
              transcriptPath: transcript?.path,
            });
            return {
              issueKey: issue.key,
              status: "error" as const,
              agentId: agent.agentId,
              error: msg,
            };
          }
        } else {
          result = waitOutcome.value;
        }

        if (streamCanceled && result.status !== "error") {
          const msg = formatAgentError(new Error("canceled"));
          yield* store.appendResolutionStep(
            issue.key,
            `Agent run error: ${msg.slice(0, 200)}`,
          );
          const recovery = yield* runRecoveryAgent({
            issue,
            config,
            roots,
            apiKey,
            kind: "agent_error",
            detail: msg,
            transcript,
            resumeAgentId: agent.agentId,
          });
          if (recovery.recovered && recovery.runId) {
            result = {
              id: recovery.runId,
              status: "finished" as const,
              result: recovery.resultText,
            };
          } else {
            yield* store.upsert({
              issueKey: issue.key,
              summary: issue.summary,
              status: "error",
              ...ws,
              branches,
              agentId: agent.agentId,
              runId: result.id,
              finishedAt: new Date().toISOString(),
              error: msg,
              resultPreview: msg.slice(0, 500),
              transcriptPath: transcript?.path,
            });
            return {
              issueKey: issue.key,
              status: "error" as const,
              agentId: agent.agentId,
              runId: result.id,
              error: msg,
            };
          }
        }

        if (result.status === "error") {
          const msg = result.result ?? "Run failed without message";
          yield* store.appendResolutionStep(
            issue.key,
            `Agent run error: ${msg.slice(0, 200)}`,
          );
          const recovery = yield* runRecoveryAgent({
            issue,
            config,
            roots,
            apiKey,
            kind: "agent_error",
            detail: msg,
            transcript,
            resumeAgentId: agent.agentId,
          });
          if (recovery.recovered && recovery.runId) {
            result = {
              id: recovery.runId,
              status: "finished",
              result: recovery.resultText,
            };
          } else {
            yield* store.upsert({
              issueKey: issue.key,
              summary: issue.summary,
              status: "error",
              ...ws,
              branches,
              agentId: agent.agentId,
              runId: result.id,
              finishedAt: new Date().toISOString(),
              error: msg,
              resultPreview: msg.slice(0, 500),
            });
            return {
              issueKey: issue.key,
              status: "error" as const,
              agentId: agent.agentId,
              runId: result.id,
              error: msg,
            };
          }
        }

        if (result.status === "cancelled") {
          yield* store.upsert({
            issueKey: issue.key,
            summary: issue.summary,
            status: "cancelled",
            ...ws,
            branches,
            agentId: agent.agentId,
            runId: result.id,
            finishedAt: new Date().toISOString(),
          });
          return {
            issueKey: issue.key,
            status: "cancelled" as const,
            agentId: agent.agentId,
            runId: result.id,
          };
        }

        let text = result.result ?? "";
        let handoff = parseHandoff(text);

        if (!agentPhaseSucceeded(handoff)) {
          const msg = `Agent finished without acceptable handoff (status=${handoff.status})`;
          yield* store.appendResolutionStep(issue.key, msg);
          const recovery = yield* runRecoveryAgent({
            issue,
            config,
            roots,
            apiKey,
            kind: "handoff",
            detail: msg,
            transcript,
            resumeAgentId: agent.agentId,
          });
          if (recovery.recovered && recovery.resultText) {
            const retryHandoff = parseHandoff(recovery.resultText);
            if (agentPhaseSucceeded(retryHandoff)) {
              handoff = retryHandoff;
              text = recovery.resultText ?? text;
            } else {
              yield* store.upsert({
                issueKey: issue.key,
                summary: issue.summary,
                status: "error",
                ...ws,
                branches,
                agentId: recovery.agentId ?? agent.agentId,
                runId: recovery.runId,
                handoffStatus: retryHandoff.status,
                handoffVerification: retryHandoff.verification,
                finishedAt: new Date().toISOString(),
                error: msg,
                resultPreview: recovery.resultText.slice(0, 500),
                transcriptPath: transcript?.path,
              });
              return {
                issueKey: issue.key,
                status: "error" as const,
                agentId: recovery.agentId,
                runId: recovery.runId,
                error: msg,
              };
            }
          } else {
            yield* store.upsert({
              issueKey: issue.key,
              summary: issue.summary,
              status: "error",
              ...ws,
              branches,
              agentId: agent.agentId,
              runId: result.id,
              handoffStatus: handoff.status,
              handoffVerification: handoff.verification,
              finishedAt: new Date().toISOString(),
              error: msg,
              resultPreview: text.slice(0, 500),
            });
            return {
              issueKey: issue.key,
              status: "error" as const,
              agentId: agent.agentId,
              runId: result.id,
              error: msg,
            };
          }
        }

        if (
          config.requireHandoffTests &&
          !verificationIsStrongEnough(handoff.verification, {
            requireTests: true,
          })
        ) {
          out.warn(
            `Handoff claims "${handoff.verification}" — verify commands are the hard gate`,
          );
        }

        let commits: Record<string, string> = {};
        const shouldCommit = config.commitWip && !options.skipCommit;
        if (shouldCommit) {
          commits = yield* commitCourseWithRecovery({
            issue,
            config,
            roots,
            apiKey,
            transcript,
            workspaces: roots.keys.map((key, i) => ({
              key,
              cwd: roots.cwds[i]!,
            })),
          });
          const workspaces = roots.keys.map((key, i) => ({
            key,
            cwd: roots.cwds[i]!,
          }));
          const dirtyAfter = yield* workspacesStillDirty(workspaces);
          const anyCommitFailed = workspaces.some(
            (w) => dirtyAfter && !(commits[w.key] ?? ""),
          );
          if (anyCommitFailed) {
            const msg =
              "WIP commit failed and working tree is still dirty — cannot advance stack";
            yield* store.appendResolutionStep(issue.key, msg);
            yield* store.upsert({
              issueKey: issue.key,
              summary: issue.summary,
              status: "error",
              ...ws,
              branches,
              agentId: agent.agentId,
              runId: result.id,
              handoffStatus: handoff.status,
              handoffVerification: handoff.verification,
              finishedAt: new Date().toISOString(),
              error: msg,
              resultPreview: text.slice(0, 500),
              transcriptPath: transcript?.path,
            });
            return {
              issueKey: issue.key,
              status: "error" as const,
              agentId: agent.agentId,
              runId: result.id,
              error: msg,
            };
          }
        }

        yield* store.upsert({
          issueKey: issue.key,
          summary: issue.summary,
          status: "agent_complete",
          ...ws,
          branches,
          commits,
          agentId: agent.agentId,
          runId: result.id,
          handoffStatus: handoff.status,
          handoffVerification: handoff.verification,
          resultPreview: text.slice(0, 500),
          transcriptPath: transcript?.path,
        });

        out.success(
          `${issue.key} agent phase (${handoff.status}, ${handoff.verification})`,
        );

        if (options.skipVerify) {
          out.warn("--skip-verify: not running verify commands");
          yield* store.upsert({
            issueKey: issue.key,
            summary: issue.summary,
            status: "verified",
            ...ws,
            branches,
            commits,
            agentId: agent.agentId,
            runId: result.id,
            handoffStatus: handoff.status,
            handoffVerification: handoff.verification,
            finishedAt: new Date().toISOString(),
            resultPreview: text.slice(0, 500),
          });
          return {
            issueKey: issue.key,
            status: "verified" as const,
            agentId: agent.agentId,
            runId: result.id,
            result: text,
          };
        }

        let verify = yield* runVerifyPhase(issue, config, roots);
        if (!verify.ok) {
          yield* store.appendResolutionStep(
            issue.key,
            verify.error ?? "Tests failed during verify",
          );
          const recovery = yield* runRecoveryAgent({
            issue,
            config,
            roots,
            apiKey,
            kind: "verify",
            detail: verify.error ?? "verify failed",
            verifyOutput: verify.output,
            transcript,
            resumeAgentId: agent.agentId,
          });
          if (recovery.recovered) {
            if (config.commitWip && !options.skipCommit) {
              commits = yield* commitCourseWithRecovery({
                issue,
                config,
                roots,
                apiKey,
                transcript,
                workspaces: roots.keys.map((key, i) => ({
                  key,
                  cwd: roots.cwds[i]!,
                })),
              });
            }
            verify = yield* runVerifyPhase(issue, config, roots);
          }
        }
        if (!verify.ok) {
          yield* store.upsert({
            issueKey: issue.key,
            summary: issue.summary,
            status: "agent_complete",
            ...ws,
            branches,
            commits,
            agentId: agent.agentId,
            runId: result.id,
            handoffStatus: handoff.status,
            handoffVerification: handoff.verification,
            verifyOutput: verify.output.slice(0, 2000),
            verifyError: verify.error,
            finishedAt: new Date().toISOString(),
            resultPreview: text.slice(0, 500),
            transcriptPath: transcript?.path,
          });
          out.error(`${issue.key} verify failed: ${verify.error}`);
          return {
            issueKey: issue.key,
            status: "agent_complete" as const,
            agentId: agent.agentId,
            runId: result.id,
            error: verify.error,
            result: text,
          };
        }

        yield* store.upsert({
          issueKey: issue.key,
          summary: issue.summary,
          status: "verified",
          ...ws,
          branches,
          commits,
          agentId: agent.agentId,
          runId: result.id,
          handoffStatus: handoff.status,
          handoffVerification: handoff.verification,
          verifyOutput: verify.output.slice(0, 2000),
          finishedAt: new Date().toISOString(),
          resultPreview: text.slice(0, 500),
        });

        out.success(`${issue.key} verified`);
        return {
          issueKey: issue.key,
          status: "verified" as const,
          agentId: agent.agentId,
          runId: result.id,
          result: text,
        };
      }).pipe(
        Effect.ensuring(
          Effect.tryPromise({
            try: () => safeDisposeAgent(agent),
            catch: () => undefined,
          }).pipe(Effect.ignore),
        ),
      );
    }).pipe(
      Effect.catchAll((err) =>
        Effect.gen(function* () {
          const message = isSdkCanceledError(err)
            ? formatAgentError(err)
            : err instanceof CursorAgentError
              ? `${err.message} (retryable=${err.isRetryable})`
              : err instanceof Error
                ? err.message
                : String(err);

          transcript?.appendBlock("fatal error", message);
          yield* store.appendResolutionStep(issue.key, message.slice(0, 300));
          yield* store.upsert({
            issueKey: issue.key,
            summary: issue.summary,
            status: "error",
            ...ws,
            branches,
            finishedAt: new Date().toISOString(),
            error: message,
            transcriptPath: transcript?.path,
          });

          out.error(`${issue.key}: ${message}`);
          return { issueKey: issue.key, status: "error" as const, error: message };
        }),
      ),
    );

    return agentResult;
  });

const workspacesStillDirty = (
  workspaces: Array<{ key: string; cwd: string }>,
): Effect.Effect<
  boolean,
  import("@effect/platform/Error").PlatformError | CommandFailed,
  import("@effect/platform/CommandExecutor").CommandExecutor
> =>
  Effect.gen(function* () {
    for (const ws of workspaces) {
      const dirty = yield* gitIsDirty(ws.cwd);
      if (dirty) return true;
    }
    return false;
  });

function commitsFromResults(results: CommitResult[]): Record<string, string> {
  const commits: Record<string, string> = {};
  for (const cr of results) {
    if (cr.committed && cr.sha) commits[cr.workspaceKey] = cr.sha;
  }
  return commits;
}

const logCommitResults = (results: CommitResult[]): Effect.Effect<void> =>
  Effect.sync(() => {
    for (const cr of results) {
      if (cr.committed) {
        out.success(`${cr.workspaceKey}: ${cr.branch} @ ${cr.sha}`);
      } else if (cr.error) {
        out.warn(`${cr.workspaceKey}: commit failed — ${cr.error}`);
      } else {
        out.info(`${cr.workspaceKey}: ${cr.branch} (clean)`);
      }
    }
  });

const commitCourseWithRecovery = (options: {
  issue: JiraIssue;
  config: DinnerConfig;
  roots: IssueWorkspaces;
  apiKey: string;
  transcript?: Transcript;
  workspaces: Array<{ key: string; cwd: string }>;
}): Effect.Effect<
  Record<string, string>,
  unknown,
  StateStore | import("@effect/platform/CommandExecutor").CommandExecutor
> =>
  Effect.gen(function* () {
    const store = yield* StateStore;
    out.phase("commit", "WIP on story branches");

    let results = yield* commitCourseWip(
      options.issue.key,
      options.issue.summary,
      options.workspaces,
    );
    yield* logCommitResults(results);

    if (!(yield* workspacesStillDirty(options.workspaces))) {
      return commitsFromResults(results);
    }

    const failed = results.filter((r) => r.error || !(r.committed && r.sha));
    if (failed.length === 0) {
      return commitsFromResults(results);
    }

    const detail = failed
      .map((r) => `${r.workspaceKey}: ${r.error ?? "dirty after commit attempt"}`)
      .join("; ");
    yield* store.appendResolutionStep(
      options.issue.key,
      `Commit failed: ${detail}`,
    );
    const recovery = yield* runRecoveryAgent({
      issue: options.issue,
      config: options.config,
      roots: options.roots,
      apiKey: options.apiKey,
      kind: "commit",
      detail,
      transcript: options.transcript,
    });

    if (recovery.recovered) {
      results = yield* commitCourseWip(
        options.issue.key,
        options.issue.summary,
        options.workspaces,
      );
      yield* logCommitResults(results);
    }

    if (yield* workspacesStillDirty(options.workspaces)) {
      const stashResults = yield* recoverDirtyWorkspaces(
        options.issue.key,
        options.issue.summary,
        options.workspaces,
      );
      for (const sr of stashResults) {
        if (sr.ok) {
          out.warn(
            `${sr.cwd}: auto-stashed (${sr.action}) so stack prep can continue`,
          );
          yield* store.appendResolutionStep(
            options.issue.key,
            `Auto-stash ${sr.action} on ${sr.cwd}`,
          );
        }
      }
    }

    return commitsFromResults(results);
  });

/** Topological order: blockers before dependents. */
export function sortByDependencies(issues: JiraIssue[]): JiraIssue[] {
  const byKey = new Map(issues.map((i) => [i.key, i]));
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const sorted: JiraIssue[] = [];

  const visit = (key: string) => {
    if (visited.has(key)) return;
    if (visiting.has(key)) return;
    visiting.add(key);
    const issue = byKey.get(key);
    if (issue) {
      for (const b of issue.parsed.blockedBy) {
        if (byKey.has(b)) visit(b);
      }
      sorted.push(issue);
    }
    visiting.delete(key);
    visited.add(key);
  };

  for (const issue of [...issues].sort((a, b) => a.key.localeCompare(b.key))) {
    visit(issue.key);
  }
  return sorted;
}
