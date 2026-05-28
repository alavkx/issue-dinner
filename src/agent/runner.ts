import { Agent, CursorAgentError } from "@cursor/sdk";
import type { DinnerConfig } from "../config.js";
import type { StackConfig } from "../stack/stack-config.js";
import {
  formatWorkspacesLabel,
  localAgentOptions,
  resolveIssueWorkspaces,
  type IssueWorkspaces,
} from "../config/workspaces.js";
import { recoverDirtyWorkspaces } from "../git/recover-workspace.js";
import {
  commitCourseWip,
  gitCurrentBranch,
  gitIsDirty,
  type CommitResult,
} from "../git/workspace.js";
import type { JiraIssue } from "../jira/acli.js";
import type { StateStore } from "../state/store.js";
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

async function recordBranches(
  roots: IssueWorkspaces,
): Promise<Record<string, string>> {
  const branches: Record<string, string> = {};
  for (let i = 0; i < roots.keys.length; i++) {
    branches[roots.keys[i]!] = await gitCurrentBranch(roots.cwds[i]!);
  }
  return branches;
}

export async function runVerifyPhase(
  issue: JiraIssue,
  config: DinnerConfig,
  roots: IssueWorkspaces,
  options: { gate?: "inner" | "full" } = {},
): Promise<{ ok: boolean; error?: string; output: string }> {
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
  const result = await runVerifyCommands(commands);
  if (!result.ok) {
    const detail = result.failures.map((f) => f.name).join(", ");
    return {
      ok: false,
      output: result.output,
      error: `Verify failed: ${detail}`,
    };
  }
  return { ok: true, output: result.output };
}

export async function verifyIssue(
  issue: JiraIssue,
  config: DinnerConfig,
  store: StateStore,
): Promise<ProcessResult> {
  const roots = resolveIssueWorkspaces(
    config,
    issue.key,
    issue.description,
    issue.summary,
  );
  const ws = stateWorkspaceFields(roots);
  const rec = store.get(issue.key);

  const verify = await runVerifyPhase(issue, config, roots);
  if (!verify.ok) {
    store.upsert({
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

  store.upsert({
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
}

export async function processIssue(
  issue: JiraIssue,
  config: DinnerConfig,
  store: StateStore,
  apiKey: string,
  options: ProcessOptions = {},
): Promise<ProcessResult> {
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
    const clean = await ensureWorkspacesCleanForIssue(config, issue, {
      label: "stack prep",
    });
    if (!clean.ok) {
      const msg = clean.detail ?? "workspace not clean for stack prep";
      store.appendResolutionStep(issue.key, `Stack prep blocked: ${msg}`);
      store.upsert({
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

    try {
      const stackActions = await checkoutWithRecovery({
        issue,
        config,
        stack: options.stack,
        store,
        apiKey,
        transcript,
      });
      for (const row of stackActions) {
        if (row.action === "noop") continue;
        out.info(`stack ${row.workspace}: ${row.action} → ${row.branch}`);
        transcript?.appendLine(
          `stack ${row.workspace}: ${row.action} → ${row.branch}`,
        );
      }
      branches = await recordBranches(roots);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : String(err);
      store.appendResolutionStep(
        issue.key,
        `Stack prep failed: ${message.slice(0, 300)}`,
      );
      store.upsert({
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
  } else if (!options.dryRun) {
    branches = await recordBranches(roots);
  }

  if (options.dryRun) {
    console.log(`[dry-run] ${issue.key} → ${formatWorkspacesLabel(roots)}\n`);
    console.log(prompt.slice(0, 1200));
    console.log("\n… (truncated)\n");
    return { issueKey: issue.key, status: "dry-run" };
  }

  store.upsert({
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

  try {
    const agent = options.resumeAgentId
      ? await Agent.resume(options.resumeAgentId, {
          apiKey,
          model: { id: config.model },
          local,
        })
      : await Agent.create({
          apiKey,
          model: { id: config.model },
          local,
        });

    try {
      const run = await agent.send(prompt);
      out.phase("stream", `agentId=${agent.agentId} runId=${run.id}`);
      transcript?.appendLine(`agentId=${agent.agentId} runId=${run.id}`);

      let streamCanceled = false;
      if (options.stream !== false) {
        const sink = {
          writeStdout: (t: string) => process.stdout.write(t),
          writeStderr: (t: string) => process.stderr.write(t),
          transcript: (t: string) => transcript?.append(t),
        };
        const drain = await drainRunStream(run.stream(), sink);
        streamCanceled = drain.canceled;
      }

      let result;
      try {
        result = await run.wait();
      } catch (waitErr) {
        streamCanceled = true;
        const msg = formatAgentError(waitErr);
        store.appendResolutionStep(issue.key, `Agent run error: ${msg.slice(0, 200)}`);
        const recovery = await runRecoveryAgent({
          issue,
          config,
          roots,
          store,
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
          store.upsert({
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
            status: "error",
            agentId: agent.agentId,
            error: msg,
          };
        }
      }

      if (streamCanceled && result.status !== "error") {
        const msg = formatAgentError(new Error("canceled"));
        store.appendResolutionStep(issue.key, `Agent run error: ${msg.slice(0, 200)}`);
        const recovery = await runRecoveryAgent({
          issue,
          config,
          roots,
          store,
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
          store.upsert({
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
            status: "error",
            agentId: agent.agentId,
            runId: result.id,
            error: msg,
          };
        }
      }

      if (result.status === "error") {
        const msg = result.result ?? "Run failed without message";
        store.appendResolutionStep(issue.key, `Agent run error: ${msg.slice(0, 200)}`);
        const recovery = await runRecoveryAgent({
          issue,
          config,
          roots,
          store,
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
        store.upsert({
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
          status: "error",
          agentId: agent.agentId,
          runId: result.id,
          error: msg,
        };
        }
      }

      if (result.status === "cancelled") {
        store.upsert({
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
          status: "cancelled",
          agentId: agent.agentId,
          runId: result.id,
        };
      }

      let text = result.result ?? "";
      let handoff = parseHandoff(text);

      if (!agentPhaseSucceeded(handoff)) {
        const msg = `Agent finished without acceptable handoff (status=${handoff.status})`;
        store.appendResolutionStep(issue.key, msg);
        const recovery = await runRecoveryAgent({
          issue,
          config,
          roots,
          store,
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
            store.upsert({
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
              status: "error",
              agentId: recovery.agentId,
              runId: recovery.runId,
              error: msg,
            };
          }
        } else {
        store.upsert({
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
          status: "error",
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
        commits = await commitCourseWithRecovery({
          issue,
          config,
          roots,
          store,
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
        const dirtyAfter = await workspacesStillDirty(workspaces);
        const anyCommitFailed = workspaces.some(
          (ws) => dirtyAfter && !(commits[ws.key] ?? ""),
        );
        if (anyCommitFailed) {
          const msg =
            "WIP commit failed and working tree is still dirty — cannot advance stack";
          store.appendResolutionStep(issue.key, msg);
          store.upsert({
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
            status: "error",
            agentId: agent.agentId,
            runId: result.id,
            error: msg,
          };
        }
      }

      store.upsert({
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
        store.upsert({
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
          status: "verified",
          agentId: agent.agentId,
          runId: result.id,
          result: text,
        };
      }

      let verify = await runVerifyPhase(issue, config, roots);
      if (!verify.ok) {
        store.appendResolutionStep(
          issue.key,
          verify.error ?? "Tests failed during verify",
        );
        const recovery = await runRecoveryAgent({
          issue,
          config,
          roots,
          store,
          apiKey,
          kind: "verify",
          detail: verify.error ?? "verify failed",
          verifyOutput: verify.output,
          transcript,
          resumeAgentId: agent.agentId,
        });
        if (recovery.recovered) {
          if (config.commitWip && !options.skipCommit) {
            commits = await commitCourseWithRecovery({
              issue,
              config,
              roots,
              store,
              apiKey,
              transcript,
              workspaces: roots.keys.map((key, i) => ({
                key,
                cwd: roots.cwds[i]!,
              })),
            });
          }
          verify = await runVerifyPhase(issue, config, roots);
        }
      }
      if (!verify.ok) {
        store.upsert({
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
          status: "agent_complete",
          agentId: agent.agentId,
          runId: result.id,
          error: verify.error,
          result: text,
        };
      }

      store.upsert({
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
        status: "verified",
        agentId: agent.agentId,
        runId: result.id,
        result: text,
      };
    } finally {
      await safeDisposeAgent(agent);
    }
  } catch (err) {
    const message = isSdkCanceledError(err)
      ? formatAgentError(err)
      : err instanceof CursorAgentError
        ? `${err.message} (retryable=${err.isRetryable})`
        : err instanceof Error
          ? err.message
          : String(err);

    transcript?.appendBlock("fatal error", message);
    store.appendResolutionStep(issue.key, message.slice(0, 300));
    store.upsert({
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
    return { issueKey: issue.key, status: "error", error: message };
  }
}

async function workspacesStillDirty(
  workspaces: Array<{ key: string; cwd: string }>,
): Promise<boolean> {
  for (const ws of workspaces) {
    if (await gitIsDirty(ws.cwd)) return true;
  }
  return false;
}

function commitsFromResults(results: CommitResult[]): Record<string, string> {
  const commits: Record<string, string> = {};
  for (const cr of results) {
    if (cr.committed && cr.sha) commits[cr.workspaceKey] = cr.sha;
  }
  return commits;
}

async function logCommitResults(results: CommitResult[]): Promise<void> {
  for (const cr of results) {
    if (cr.committed) {
      out.success(`${cr.workspaceKey}: ${cr.branch} @ ${cr.sha}`);
    } else if (cr.error) {
      out.warn(`${cr.workspaceKey}: commit failed — ${cr.error}`);
    } else {
      out.info(`${cr.workspaceKey}: ${cr.branch} (clean)`);
    }
  }
}

async function commitCourseWithRecovery(options: {
  issue: JiraIssue;
  config: DinnerConfig;
  roots: IssueWorkspaces;
  store: StateStore;
  apiKey: string;
  transcript?: Transcript;
  workspaces: Array<{ key: string; cwd: string }>;
}): Promise<Record<string, string>> {
  out.phase("commit", "WIP on story branches");

  let results = await commitCourseWip(
    options.issue.key,
    options.issue.summary,
    options.workspaces,
  );
  await logCommitResults(results);

  if (!(await workspacesStillDirty(options.workspaces))) {
    return commitsFromResults(results);
  }

  const failed = results.filter((r) => r.error || !(r.committed && r.sha));
  if (failed.length === 0) {
    return commitsFromResults(results);
  }

  const detail = failed
    .map((r) => `${r.workspaceKey}: ${r.error ?? "dirty after commit attempt"}`)
    .join("; ");
  options.store.appendResolutionStep(
    options.issue.key,
    `Commit failed: ${detail}`,
  );
  const recovery = await runRecoveryAgent({
    issue: options.issue,
    config: options.config,
    roots: options.roots,
    store: options.store,
    apiKey: options.apiKey,
    kind: "commit",
    detail,
    transcript: options.transcript,
  });

  if (recovery.recovered) {
    results = await commitCourseWip(
      options.issue.key,
      options.issue.summary,
      options.workspaces,
    );
    await logCommitResults(results);
  }

  if (await workspacesStillDirty(options.workspaces)) {
    const stashResults = await recoverDirtyWorkspaces(
      options.issue.key,
      options.issue.summary,
      options.workspaces,
    );
    for (const sr of stashResults) {
      if (sr.ok) {
        out.warn(
          `${sr.cwd}: auto-stashed (${sr.action}) so stack prep can continue`,
        );
        options.store.appendResolutionStep(
          options.issue.key,
          `Auto-stash ${sr.action} on ${sr.cwd}`,
        );
      }
    }
  }

  return commitsFromResults(results);
}

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
