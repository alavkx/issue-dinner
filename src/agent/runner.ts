import { Agent, CursorAgentError } from "@cursor/sdk";
import type { DinnerConfig } from "../config.js";
import type { StackConfig } from "../stack/stack-config.js";
import {
  formatWorkspacesLabel,
  localAgentOptions,
  resolveIssueWorkspaces,
  type IssueWorkspaces,
} from "../config/workspaces.js";
import { commitCourseWip, gitCurrentBranch } from "../git/workspace.js";
import type { JiraIssue } from "../jira/acli.js";
import type { StateStore } from "../state/store.js";
import { resolveVerifyCommandsForIssue } from "../verify/resolve.js";
import { runVerifyCommands } from "../verify/runner.js";
import {
  agentPhaseSucceeded,
  parseHandoff,
  verificationIsStrongEnough,
} from "./handoff.js";
import { buildAgentPrompt } from "./prompt.js";
import { checkoutIssueStack } from "../stack/prep.js";
import { createGraphiteStackPort } from "../stack/graphite-runner.js";

export interface ProcessOptions {
  dryRun?: boolean;
  stream?: boolean;
  resumeAgentId?: string;
  skipVerify?: boolean;
  skipCommit?: boolean;
  stack?: StackConfig;
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

function writeAssistantText(event: {
  type: string;
  message?: { content?: Array<{ type: string; text?: string }> };
  text?: string;
}): void {
  if (event.type === "assistant" && event.message?.content) {
    for (const block of event.message.content) {
      if (block.type === "text" && block.text) {
        process.stdout.write(block.text);
      }
    }
  }
  if (event.type === "thinking" && event.text) {
    process.stderr.write(event.text);
  }
}

export async function runVerifyPhase(
  issue: JiraIssue,
  config: DinnerConfig,
  roots: IssueWorkspaces,
): Promise<{ ok: boolean; error?: string; output: string }> {
  if (!config.requireVerify) {
    return { ok: true, output: "(verify disabled in config)" };
  }

  const commands = resolveVerifyCommandsForIssue(config, issue.key, roots.keys);
  if (commands.length === 0) {
    return {
      ok: false,
      output: "",
      error: `No verifyCommands for ${issue.key} (roots: ${roots.keys.join(", ")})`,
    };
  }

  console.log(
    `\n🔎 Verifying ${issue.key} (${commands.length} command(s) across ${roots.keys.length} root(s))…\n`,
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

  console.log(`\n✓ ${issue.key} verified\n`);
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

  if (options.stack && !options.dryRun) {
    const stackActions = await checkoutIssueStack(
      issue,
      config,
      options.stack,
      createGraphiteStackPort(),
    );
    for (const row of stackActions) {
      if (row.action === "noop") continue;
      console.log(`   stack ${row.workspace}: ${row.action} → ${row.branch}`);
    }
  }

  const branches = options.dryRun ? {} : await recordBranches(roots);

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
    startedAt: new Date().toISOString(),
  });

  console.log(`\n🍽  Serving ${issue.key}: ${issue.summary}`);
  console.log(`   ${formatWorkspacesLabel(roots)}`);
  const local = localAgentOptions(config, roots.cwds);
  console.log(
    `   local agent cwd=${JSON.stringify(local.cwd)} (not cloud)\n`,
  );

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
      console.log(`   agentId=${agent.agentId} runId=${run.id}`);

      if (options.stream !== false) {
        for await (const event of run.stream()) {
          writeAssistantText(event as Parameters<typeof writeAssistantText>[0]);
        }
      }

      const result = await run.wait();

      if (result.status === "error") {
        const msg = result.result ?? "Run failed without message";
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

      const text = result.result ?? "";
      const handoff = parseHandoff(text);

      if (!agentPhaseSucceeded(handoff)) {
        const msg = `Agent finished without acceptable handoff (status=${handoff.status})`;
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

      if (
        config.requireHandoffTests &&
        !verificationIsStrongEnough(handoff.verification, {
          requireTests: true,
        })
      ) {
        console.warn(
          `   ⚠ Handoff claims "${handoff.verification}" — verify commands are the hard gate.`,
        );
      }

      let commits: Record<string, string> = {};
      const shouldCommit = config.commitWip && !options.skipCommit;
      if (shouldCommit) {
        console.log(`\n📦 Committing WIP on story branches…`);
        const commitResults = await commitCourseWip(
          issue.key,
          issue.summary,
          roots.keys.map((key, i) => ({ key, cwd: roots.cwds[i]! })),
        );
        for (const cr of commitResults) {
          if (cr.committed) {
            commits[cr.workspaceKey] = cr.sha ?? "";
            console.log(
              `   ${cr.workspaceKey}: ${cr.branch} @ ${cr.sha} — ${cr.message}`,
            );
          } else if (cr.error) {
            console.warn(`   ${cr.workspaceKey}: commit failed — ${cr.error}`);
          } else {
            console.log(`   ${cr.workspaceKey}: ${cr.branch} (clean)`);
          }
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
      });

      console.log(
        `\n✓ ${issue.key} agent phase (${handoff.status}, ${handoff.verification})\n`,
      );

      if (options.skipVerify) {
        console.warn("   ⚠ --skip-verify: not running verify commands");
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

      const verify = await runVerifyPhase(issue, config, roots);
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
        });
        console.error(`\n✗ ${issue.key} verify failed: ${verify.error}\n`);
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

      console.log(`\n✓ ${issue.key} verified\n`);
      return {
        issueKey: issue.key,
        status: "verified",
        agentId: agent.agentId,
        runId: result.id,
        result: text,
      };
    } finally {
      await agent[Symbol.asyncDispose]();
    }
  } catch (err) {
    const message =
      err instanceof CursorAgentError
        ? `${err.message} (retryable=${err.isRetryable})`
        : err instanceof Error
          ? err.message
          : String(err);

    store.upsert({
      issueKey: issue.key,
      summary: issue.summary,
      status: "error",
      ...ws,
      branches,
      finishedAt: new Date().toISOString(),
      error: message,
    });

    return { issueKey: issue.key, status: "error", error: message };
  }
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
