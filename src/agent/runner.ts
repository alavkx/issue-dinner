import { Agent, CursorAgentError } from "@cursor/sdk";
import type { DinnerConfig } from "../config.js";
import { localAgentOptions, resolveCwd, resolveWorkspaceKey } from "../config.js";
import type { JiraIssue } from "../jira/acli.js";
import type { StateStore } from "../state/store.js";
import { resolveVerifyCommands } from "../verify/resolve.js";
import { runVerifyCommands } from "../verify/runner.js";
import {
  agentPhaseSucceeded,
  parseHandoff,
  verificationIsStrongEnough,
} from "./handoff.js";
import { buildAgentPrompt } from "./prompt.js";

export interface ProcessOptions {
  dryRun?: boolean;
  stream?: boolean;
  resumeAgentId?: string;
  skipVerify?: boolean;
}

export interface ProcessResult {
  issueKey: string;
  status: "verified" | "error" | "cancelled" | "dry-run";
  agentId?: string;
  runId?: string;
  result?: string;
  error?: string;
}

function relatedWorkspacePaths(
  config: DinnerConfig,
  primaryKey: string,
): string[] {
  return Object.entries(config.workspaces)
    .filter(([k]) => k !== primaryKey)
    .map(([, p]) => p);
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
  workspaceKey: string,
  cwd: string,
): Promise<{ ok: boolean; error?: string; output: string }> {
  if (!config.requireVerify) {
    return { ok: true, output: "(verify disabled in config)" };
  }

  const commands = resolveVerifyCommands(config, issue.key, workspaceKey);
  if (commands.length === 0) {
    return {
      ok: false,
      output: "",
      error: `No verifyCommands for ${issue.key} / workspace ${workspaceKey}`,
    };
  }

  console.log(`\n🔎 Verifying ${issue.key} (${commands.length} command(s))…\n`);
  const result = await runVerifyCommands(commands, cwd);
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
  const workspaceKey = resolveWorkspaceKey(
    config,
    issue.key,
    issue.description,
    issue.summary,
  );
  const cwd = resolveCwd(config, workspaceKey);
  const rec = store.get(issue.key);

  const verify = await runVerifyPhase(issue, config, workspaceKey, cwd);
  if (!verify.ok) {
    store.upsert({
      issueKey: issue.key,
      summary: issue.summary,
      status: "error",
      workspace: workspaceKey,
      cwd,
      error: verify.error,
      verifyOutput: verify.output.slice(0, 2000),
      finishedAt: new Date().toISOString(),
    });
    return { issueKey: issue.key, status: "error", error: verify.error };
  }

  store.upsert({
    issueKey: issue.key,
    summary: issue.summary,
    status: "verified",
    workspace: workspaceKey,
    cwd,
    agentId: rec?.agentId,
    runId: rec?.runId,
    handoffStatus: rec?.handoffStatus,
    handoffVerification: rec?.handoffVerification,
    verifyOutput: verify.output.slice(0, 2000),
    finishedAt: new Date().toISOString(),
    resultPreview: rec?.resultPreview,
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
  const workspaceKey = resolveWorkspaceKey(
    config,
    issue.key,
    issue.description,
    issue.summary,
  );
  const cwd = resolveCwd(config, workspaceKey);
  const prompt = buildAgentPrompt({
    issue,
    cwd,
    workspaceKey,
    relatedPaths: relatedWorkspacePaths(config, workspaceKey),
  });

  if (options.dryRun) {
    console.log(`[dry-run] ${issue.key} → ${workspaceKey} (${cwd})\n`);
    console.log(prompt.slice(0, 1200));
    console.log("\n… (truncated)\n");
    return { issueKey: issue.key, status: "dry-run" };
  }

  store.upsert({
    issueKey: issue.key,
    summary: issue.summary,
    status: "running",
    workspace: workspaceKey,
    cwd,
    startedAt: new Date().toISOString(),
  });

  console.log(`\n🍽  Serving ${issue.key}: ${issue.summary}`);
  console.log(`   workspace=${workspaceKey} cwd=${cwd}\n`);

  try {
    const local = localAgentOptions(config, cwd);
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
          workspace: workspaceKey,
          cwd,
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
          workspace: workspaceKey,
          cwd,
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
          workspace: workspaceKey,
          cwd,
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

      store.upsert({
        issueKey: issue.key,
        summary: issue.summary,
        status: "agent_complete",
        workspace: workspaceKey,
        cwd,
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
        return {
          issueKey: issue.key,
          status: "verified",
          agentId: agent.agentId,
          runId: result.id,
          result: text,
        };
      }

      const verify = await runVerifyPhase(issue, config, workspaceKey, cwd);
      if (!verify.ok) {
        store.upsert({
          issueKey: issue.key,
          summary: issue.summary,
          status: "error",
          workspace: workspaceKey,
          cwd,
          agentId: agent.agentId,
          runId: result.id,
          handoffStatus: handoff.status,
          handoffVerification: handoff.verification,
          verifyOutput: verify.output.slice(0, 2000),
          finishedAt: new Date().toISOString(),
          error: verify.error,
          resultPreview: text.slice(0, 500),
        });
        return {
          issueKey: issue.key,
          status: "error",
          agentId: agent.agentId,
          runId: result.id,
          error: verify.error,
        };
      }

      store.upsert({
        issueKey: issue.key,
        summary: issue.summary,
        status: "verified",
        workspace: workspaceKey,
        cwd,
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
      workspace: workspaceKey,
      cwd,
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
