import { Agent, CursorAgentError } from "@cursor/sdk";
import type { DinnerConfig } from "../config.js";
import { resolveCwd, resolveWorkspaceKey } from "../config.js";
import type { JiraIssue } from "../jira/acli.js";
import type { StateStore } from "../state/store.js";
import { buildAgentPrompt } from "./prompt.js";

export interface ProcessOptions {
  dryRun?: boolean;
  stream?: boolean;
  resumeAgentId?: string;
}

export interface ProcessResult {
  issueKey: string;
  status: "finished" | "error" | "cancelled" | "dry-run";
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
    const agent = options.resumeAgentId
      ? await Agent.resume(options.resumeAgentId, {
          apiKey,
          model: { id: config.model },
          local: { cwd, settingSources: [] },
        })
      : await Agent.create({
          apiKey,
          model: { id: config.model },
          local: { cwd, settingSources: [] },
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
      store.upsert({
        issueKey: issue.key,
        summary: issue.summary,
        status: "finished",
        workspace: workspaceKey,
        cwd,
        agentId: agent.agentId,
        runId: result.id,
        finishedAt: new Date().toISOString(),
        resultPreview: text.slice(0, 500),
      });

      console.log(`\n✓ ${issue.key} finished (${result.durationMs ?? "?"}ms)\n`);
      return {
        issueKey: issue.key,
        status: "finished",
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
