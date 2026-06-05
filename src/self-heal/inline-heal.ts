import type { MachineConfig } from "../config.js";
import {
  storyAgentOptions,
  type IssueWorkspaces,
} from "../config/workspaces.js";
import type { JiraIssue } from "../jira/acli.js";
import {
  createOrResumeAgent,
  disposeAgent,
  sendPrompt,
  waitForRun,
} from "../agent/lifecycle.js";
import { drainRunStream } from "../agent/stream-handler.js";
import { formatAgentError } from "../agent/sdk-errors.js";
import * as FileSystem from "@effect/platform/FileSystem";
import type * as CommandExecutor from "@effect/platform/CommandExecutor";
import * as Effect from "effect/Effect";
import { requestRestart } from "../runtime/relaunch.js";
import * as out from "../ui/out.js";
import type { ServeHealContext } from "./heal-agent.js";
import {
  diffSrcSnapshot,
  manifestLooksForeign,
  persistDurableHeal,
  recordHealApplied,
  snapshotSrcFiles,
} from "./durable-patches.js";
import {
  agentDeclinedHeal,
  buildInlineHealBuildPrompt,
  buildInlineHealTypecheckPrompt,
  extractHealSummary,
} from "./heal-prompt.js";
import { buildHealSessionId, saveHealResume } from "./heal-resume.js";
import type { HealPatchManifest } from "./patch.js";
import { isIssueDinnerPackageRoot, readPackageName, runBuild, runTypecheck } from "./heal-validation.js";

export interface InlineHealResult {
  readonly outcome: "healed" | "no_changes" | "declined" | "exhausted";
  readonly restarted: boolean;
  readonly fixSummary?: string;
  readonly patchId?: string;
  readonly error?: string;
}

export interface InlineHealOptions {
  readonly issue: JiraIssue;
  readonly toolRoot: string;
  readonly config: MachineConfig;
  readonly apiKey: string;
  readonly roots: IssueWorkspaces;
  readonly serveHeal: ServeHealContext;
  readonly baseline: ReadonlyMap<string, string>;
  readonly storyAgentId?: string;
  readonly failureDetail?: string;
  readonly configPath?: string;
}

const slugifyPatchId = (issueKey: string, sessionId: string): string => {
  const tail = sessionId.split("-").pop() ?? "0";
  return `inline-${issueKey.toLowerCase()}-${tail}`;
};

const runInlineStoryAgentTurn = (options: {
  apiKey: string;
  config: MachineConfig;
  roots: IssueWorkspaces;
  toolRoot: string;
  prompt: string;
  storyAgentId?: string;
}): Effect.Effect<
  { agentId: string; text: string; declined: boolean } | null,
  unknown,
  FileSystem.FileSystem | CommandExecutor.CommandExecutor
> =>
  Effect.gen(function* () {
    const local = storyAgentOptions(
      options.config,
      options.roots,
      options.toolRoot,
    );
    const agent = yield* createOrResumeAgent({
      resumeAgentId: options.storyAgentId,
      create: {
        apiKey: options.apiKey,
        model: { id: options.config.model },
        local,
      },
    });

    const result = yield* Effect.gen(function* () {
      const run = yield* sendPrompt(agent, options.prompt);
      out.phase("inline heal stream", `agentId=${agent.agentId} runId=${run.id}`);
      yield* drainRunStream(run.stream(), {
        writeStdout: (t) => process.stdout.write(t),
        writeStderr: (t) => process.stderr.write(t),
      });
      const waitOutcome = yield* waitForRun(run);
      if (!waitOutcome.ok) {
        out.warn(`inline heal wait: ${formatAgentError(waitOutcome.err)}`);
        return null;
      }
      const value = waitOutcome.value;
      if (value.status === "error" || value.status === "cancelled") {
        return null;
      }
      const text = value.result ?? "";
      return {
        agentId: agent.agentId,
        text,
        declined: agentDeclinedHeal(text),
      };
    }).pipe(Effect.ensuring(disposeAgent(agent)));

    return result;
  });

export const finalizeInlineHeal = (
  options: InlineHealOptions,
): Effect.Effect<
  InlineHealResult,
  unknown,
  FileSystem.FileSystem | CommandExecutor.CommandExecutor
> =>
  Effect.gen(function* () {
    const current = yield* snapshotSrcFiles(options.toolRoot);
    const changed = diffSrcSnapshot(options.baseline, current);
    if (changed.length === 0) {
      return { outcome: "no_changes", restarted: false };
    }

    const isIssueDinnerRoot = yield* isIssueDinnerPackageRoot(options.toolRoot);
    if (!isIssueDinnerRoot) {
      const packageName = yield* readPackageName(options.toolRoot);
      out.warn(
        `inline heal: skipping validation — toolRoot is ${packageName ?? "unknown"} at ${options.toolRoot}, not issue-dinner`,
      );
      return { outcome: "no_changes", restarted: false };
    }

    out.phase(
      "inline heal",
      `${options.issue.key} — ${changed.length} src file(s) edited by story agent`,
    );

    const maxIterations = options.config.healTypecheckIterations ?? 8;
    const sessionId = buildHealSessionId(options.issue.key);
    let storyAgentId = options.storyAgentId;
    let lastSummary = `Story agent edited ${changed.length} issue-dinner file(s).`;

    let typecheckPassed = false;
    for (let tc = 1; tc <= maxIterations; tc++) {
      const tcResult = yield* runTypecheck(options.toolRoot);
      if (tcResult.ok) {
        typecheckPassed = true;
        break;
      }

      if (tc === 1 && !storyAgentId) {
        out.warn(
          "inline heal: typecheck failed but no story agent to resume — escalating",
        );
        return {
          outcome: "exhausted",
          restarted: false,
          error: "typecheck failed with no story agent to iterate",
        };
      }

      out.info(`inline heal: typecheck iteration ${tc}/${maxIterations}`);
      const feedback = yield* runInlineStoryAgentTurn({
        apiKey: options.apiKey,
        config: options.config,
        roots: options.roots,
        toolRoot: options.toolRoot,
        prompt: buildInlineHealTypecheckPrompt({
          toolRoot: options.toolRoot,
          errors: tcResult.output,
          iteration: tc,
          maxIterations,
        }),
        storyAgentId,
      });
      if (feedback === null) break;
      storyAgentId = feedback.agentId;
      lastSummary = extractHealSummary(feedback.text);
      if (feedback.declined) {
        return { outcome: "declined", restarted: false };
      }
    }

    if (!typecheckPassed) {
      return {
        outcome: "exhausted",
        restarted: false,
        error: `Inline heal typecheck exhausted after ${maxIterations} iteration(s)`,
      };
    }

    let buildPassed = false;
    for (let bc = 1; bc <= maxIterations; bc++) {
      const buildResult = yield* runBuild(options.toolRoot);
      if (buildResult.ok) {
        buildPassed = true;
        break;
      }

      out.info(`inline heal: build iteration ${bc}/${maxIterations}`);
      const feedback = yield* runInlineStoryAgentTurn({
        apiKey: options.apiKey,
        config: options.config,
        roots: options.roots,
        toolRoot: options.toolRoot,
        prompt: buildInlineHealBuildPrompt({
          toolRoot: options.toolRoot,
          errors: buildResult.output,
          iteration: bc,
          maxIterations,
        }),
        storyAgentId,
      });
      if (feedback === null) break;
      storyAgentId = feedback.agentId;
      lastSummary = extractHealSummary(feedback.text);
      if (feedback.declined) {
        return { outcome: "declined", restarted: false };
      }
    }

    if (!buildPassed) {
      return {
        outcome: "exhausted",
        restarted: false,
        error: `Inline heal build exhausted after ${maxIterations} iteration(s)`,
      };
    }

    const finalSnapshot = yield* snapshotSrcFiles(options.toolRoot);
    const finalChanged = diffSrcSnapshot(options.baseline, finalSnapshot);
    if (finalChanged.length === 0) {
      out.warn("inline heal: typecheck/build passed but src matches baseline");
      return { outcome: "no_changes", restarted: false };
    }

    const patchId = slugifyPatchId(options.issue.key, sessionId);
    const packageName = yield* readPackageName(options.toolRoot);
    const manifest: HealPatchManifest = {
      id: patchId,
      issueKey: options.issue.key,
      packageName: packageName ?? undefined,
      reason: lastSummary.split("\n")[0]?.slice(0, 200) ?? "inline heal",
      files: finalChanged.map((f) => ({ path: f.path, content: f.content })),
    };

    if (manifestLooksForeign(manifest)) {
      out.warn(
        "inline heal: refusing to persist — src changes look like project workspace edits, not issue-dinner",
      );
      return { outcome: "no_changes", restarted: false };
    }

    yield* persistDurableHeal(manifest);
    yield* recordHealApplied(options.toolRoot, manifest);

    yield* saveHealResume({
      version: 1,
      epic: options.serveHeal.epic,
      issueKey: options.issue.key,
      storyIndex: options.serveHeal.storyIndex,
      serveArgv: options.serveHeal.serveArgv,
      configPath: options.configPath ?? options.serveHeal.configPath,
      storyAgentId,
      trigger: "inline",
      failureDetail:
        options.failureDetail ??
        `Story agent edited issue-dinner source (${finalChanged.length} file(s))`,
      healSessionId: sessionId,
      patchId,
      fixSummary: lastSummary,
      postHealResume: true,
    });

    out.success(
      `inline heal: patched ${finalChanged.length} file(s) — restarting`,
    );
    yield* requestRestart(options.serveHeal.serveArgv);
    return {
      outcome: "healed",
      restarted: true,
      fixSummary: lastSummary,
      patchId,
    };
  });

export const attemptInlineHealFromStory = (options: {
  issue: JiraIssue;
  config: MachineConfig;
  apiKey: string;
  selfHeal?: boolean;
  toolRoot?: string;
  roots: IssueWorkspaces;
  serveHeal?: ServeHealContext;
  baseline?: ReadonlyMap<string, string>;
  storyAgentId?: string;
  failureDetail?: string;
}): Effect.Effect<
  InlineHealResult | undefined,
  unknown,
  FileSystem.FileSystem | CommandExecutor.CommandExecutor
> =>
  Effect.gen(function* () {
    if (
      !options.selfHeal ||
      !options.toolRoot ||
      !options.serveHeal ||
      !options.baseline
    ) {
      return undefined;
    }

    const isIssueDinnerRoot = yield* isIssueDinnerPackageRoot(options.toolRoot);
    if (!isIssueDinnerRoot) {
      return undefined;
    }

    return yield* finalizeInlineHeal({
      issue: options.issue,
      toolRoot: options.toolRoot,
      config: options.config,
      apiKey: options.apiKey,
      roots: options.roots,
      serveHeal: options.serveHeal,
      baseline: options.baseline,
      storyAgentId: options.storyAgentId,
      failureDetail: options.failureDetail,
      configPath: options.serveHeal.configPath,
    });
  });
