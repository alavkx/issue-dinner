import { Agent } from "@cursor/sdk";
import type { DinnerConfig } from "../config.js";
import type { StackConfig } from "../stack/stack-config.js";
import {
  localAgentOptions,
  resolveIssueWorkspaces,
  type IssueWorkspaces,
} from "../config/workspaces.js";
import type { JiraIssue } from "../jira/acli.js";
import type { StateStore } from "../state/store.js";
import { recoverDirtyWorkspaces } from "../git/recover-workspace.js";
import { checkoutIssueStack } from "../stack/prep.js";
import { createGraphiteStackPort } from "../stack/graphite-runner.js";
import type { StackActionSummary } from "../stack/prep.js";
import * as out from "../ui/out.js";
import { drainRunStream } from "./stream-handler.js";
import { formatAgentError, isSdkCanceledError, safeDisposeAgent } from "./sdk-errors.js";
import {
  agentPhaseSucceeded,
  parseHandoff,
  type ParsedHandoff,
} from "./handoff.js";
import {
  buildRecoveryPrompt,
  type RecoveryKind,
} from "./recovery-prompt.js";
import type { Transcript } from "../serve/transcript.js";

export interface RecoveryResult {
  recovered: boolean;
  handoff?: ParsedHandoff;
  agentId?: string;
  runId?: string;
  resultText?: string;
  error?: string;
}

function recordStep(
  store: StateStore,
  issueKey: string,
  step: string,
  transcript?: Transcript,
): void {
  store.appendResolutionStep(issueKey, step);
  transcript?.appendLine(step);
}

export async function runRecoveryAgent(options: {
  issue: JiraIssue;
  config: DinnerConfig;
  roots: IssueWorkspaces;
  store: StateStore;
  apiKey: string;
  kind: RecoveryKind;
  detail: string;
  verifyOutput?: string;
  transcript?: Transcript;
  resumeAgentId?: string;
}): Promise<RecoveryResult> {
  const max = options.config.recoveryAttempts ?? 2;
  const local = localAgentOptions(options.config, options.roots.cwds);

  for (let attempt = 1; attempt <= max; attempt++) {
    const step = `Recovery ${options.kind} attempt ${attempt}/${max}`;
    out.warn(`${options.issue.key}: ${step}`);
    recordStep(options.store, options.issue.key, step, options.transcript);

    const quietRecovery = options.config.quietRecovery !== false;
    if (quietRecovery) {
      out.info(
        `${options.issue.key}: recovery agent running (full stream in transcript)`,
      );
    }

    const prompt = buildRecoveryPrompt({
      issue: options.issue,
      roots: options.roots,
      kind: options.kind,
      detail: options.detail,
      verifyOutput: options.verifyOutput,
      attempt,
      maxAttempts: max,
    });

    try {
      const agent =
        attempt === 1 && options.resumeAgentId
          ? await Agent.resume(options.resumeAgentId, {
              apiKey: options.apiKey,
              model: { id: options.config.model },
              local,
            })
          : await Agent.create({
              apiKey: options.apiKey,
              model: { id: options.config.model },
              local,
            });

      try {
        const run = await agent.send(prompt);
        out.phase("recovery stream", `${options.issue.key} agent=${agent.agentId}`);

        const sink = {
          writeStdout: quietRecovery
            ? () => {}
            : (t: string) => process.stdout.write(t),
          writeStderr: quietRecovery
            ? () => {}
            : (t: string) => process.stderr.write(t),
          transcript: (t: string) => options.transcript?.append(t),
        };
        const drain = await drainRunStream(run.stream(), sink);

        let result;
        try {
          result = await run.wait();
        } catch (waitErr) {
          const msg = formatAgentError(waitErr);
          recordStep(
            options.store,
            options.issue.key,
            `Recovery run error: ${msg.slice(0, 200)}`,
            options.transcript,
          );
          continue;
        }

        if (drain.canceled || result.status === "cancelled") {
          recordStep(
            options.store,
            options.issue.key,
            "Recovery agent canceled (stall timeout or abort)",
            options.transcript,
          );
          continue;
        }

        if (result.status === "error") {
          const msg = result.result ?? result.status;
          recordStep(
            options.store,
            options.issue.key,
            `Recovery run ${result.status}: ${msg.slice(0, 200)}`,
            options.transcript,
          );
          continue;
        }

        const text = result.result ?? "";
        const handoff = parseHandoff(text);
        if (!agentPhaseSucceeded(handoff)) {
          recordStep(
            options.store,
            options.issue.key,
            `Recovery handoff not acceptable (status=${handoff.status})`,
            options.transcript,
          );
          continue;
        }

        recordStep(
          options.store,
          options.issue.key,
          `Recovery agent succeeded (${handoff.verification})`,
          options.transcript,
        );
        return {
          recovered: true,
          handoff,
          agentId: agent.agentId,
          runId: result.id,
          resultText: text,
        };
      } finally {
        await safeDisposeAgent(agent);
      }
    } catch (err) {
      const msg = formatAgentError(err);
      const step = isSdkCanceledError(err)
        ? "Recovery agent canceled (stall timeout or abort)"
        : `Recovery agent error: ${msg.slice(0, 200)}`;
      recordStep(options.store, options.issue.key, step, options.transcript);
    }
  }

  return { recovered: false, error: `Recovery exhausted after ${max} attempt(s)` };
}

async function tryProgrammaticStackRecovery(options: {
  issue: JiraIssue;
  config: DinnerConfig;
  store: StateStore;
  transcript?: Transcript;
}): Promise<boolean> {
  const roots = resolveIssueWorkspaces(
    options.config,
    options.issue.key,
    options.issue.description,
    options.issue.summary,
  );
  const workspaces = roots.keys.map((key, i) => ({
    key,
    cwd: roots.cwds[i]!,
  }));
  const results = await recoverDirtyWorkspaces(
    options.issue.key,
    options.issue.summary,
    workspaces,
  );
  const ok = results.every((r) => r.ok);
  if (ok && results.some((r) => r.action !== "already_clean")) {
    recordStep(
      options.store,
      options.issue.key,
      `Programmatic stack recovery: ${results.map((r) => r.action).join(", ")}`,
      options.transcript,
    );
  }
  return ok;
}

export async function checkoutWithRecovery(options: {
  issue: JiraIssue;
  config: DinnerConfig;
  stack: StackConfig;
  store: StateStore;
  apiKey: string;
  transcript?: Transcript;
}): Promise<StackActionSummary[]> {
  const port = createGraphiteStackPort();
  try {
    return await checkoutIssueStack(
      options.issue,
      options.config,
      options.stack,
      port,
    );
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    if (detail.includes("working tree is dirty")) {
      const cleaned = await tryProgrammaticStackRecovery(options);
      if (cleaned) {
        out.success("Programmatic workspace recovery — retrying checkout");
        try {
          return await checkoutIssueStack(
            options.issue,
            options.config,
            options.stack,
            port,
          );
        } catch (retryErr) {
          const retryDetail =
            retryErr instanceof Error ? retryErr.message : String(retryErr);
          out.error(`Stack prep still failed: ${retryDetail}`);
        }
      }
    }

    out.error(`Stack prep failed: ${detail}`);
    options.transcript?.appendBlock("stack prep failed", detail);
    recordStep(
      options.store,
      options.issue.key,
      `Stack prep failed: ${detail.slice(0, 300)}`,
      options.transcript,
    );

    const roots = resolveIssueWorkspaces(
      options.config,
      options.issue.key,
      options.issue.description,
      options.issue.summary,
    );

    await tryProgrammaticStackRecovery(options);
    try {
      out.success("Programmatic recovery — retrying checkout");
      return await checkoutIssueStack(
        options.issue,
        options.config,
        options.stack,
        port,
      );
    } catch {
      /* fall through to agent recovery */
    }

    const recovery = await runRecoveryAgent({
      issue: options.issue,
      config: options.config,
      roots,
      store: options.store,
      apiKey: options.apiKey,
      kind: "stack_prep",
      detail,
      transcript: options.transcript,
    });

    await tryProgrammaticStackRecovery(options);
    try {
      return await checkoutIssueStack(
        options.issue,
        options.config,
        options.stack,
        port,
      );
    } catch (retryErr) {
      const retryDetail =
        retryErr instanceof Error ? retryErr.message : String(retryErr);
      recordStep(
        options.store,
        options.issue.key,
        `Stack prep still failed: ${retryDetail.slice(0, 300)}`,
        options.transcript,
      );
      throw err;
    }
  }
}
