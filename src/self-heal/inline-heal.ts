import type { MachineConfig } from "../config.js";
import {
  courseAgentOptions,
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
  persistDurableHeal,
  recordHealInKitchenApplied,
  snapshotSrcFiles,
} from "./durable-patches.js";
import {
  agentDeclinedHeal,
  buildInlineHealBuildPrompt,
  buildInlineHealTypecheckPrompt,
  extractHealSummary,
} from "./heal-prompt.js";
import { buildHealSessionId, saveHealResume } from "./heal-resume.js";
import type { KitchenPatchManifest } from "./patch.js";
import { runBuild, runTypecheck } from "./heal-validation.js";

export interface InlineHealResult {
  readonly outcome: "healed" | "no_changes" | "declined" | "exhausted";
  readonly restarted: boolean;
  readonly fixSummary?: string;
  readonly patchId?: string;
  readonly error?: string;
}

export interface InlineHealOptions {
  readonly issue: JiraIssue;
  readonly kitchenRoot: string;
  readonly config: MachineConfig;
  readonly apiKey: string;
  readonly roots: IssueWorkspaces;
  readonly serveHeal: ServeHealContext;
  readonly baseline: ReadonlyMap<string, string>;
  readonly courseAgentId?: string;
  readonly failureDetail?: string;
  readonly configPath?: string;
}

const slugifyPatchId = (issueKey: string, sessionId: string): string => {
  const tail = sessionId.split("-").pop() ?? "0";
  return `inline-${issueKey.toLowerCase()}-${tail}`;
};

const runInlineCourseAgentTurn = (options: {
  apiKey: string;
  config: MachineConfig;
  roots: IssueWorkspaces;
  kitchenRoot: string;
  prompt: string;
  courseAgentId?: string;
}): Effect.Effect<
  { agentId: string; text: string; declined: boolean } | null,
  unknown,
  FileSystem.FileSystem | CommandExecutor.CommandExecutor
> =>
  Effect.gen(function* () {
    const local = courseAgentOptions(
      options.config,
      options.roots,
      options.kitchenRoot,
    );
    const agent = yield* createOrResumeAgent({
      resumeAgentId: options.courseAgentId,
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
    const current = yield* snapshotSrcFiles(options.kitchenRoot);
    const changed = diffSrcSnapshot(options.baseline, current);
    if (changed.length === 0) {
      return { outcome: "no_changes", restarted: false };
    }

    out.phase(
      "inline heal",
      `${options.issue.key} — ${changed.length} src file(s) edited by course agent`,
    );

    const maxIterations = options.config.healTypecheckIterations ?? 8;
    const sessionId = buildHealSessionId(options.issue.key);
    let courseAgentId = options.courseAgentId;
    let lastSummary = `Course agent edited ${changed.length} issue-dinner file(s).`;

    let typecheckPassed = false;
    for (let tc = 1; tc <= maxIterations; tc++) {
      const tcResult = yield* runTypecheck(options.kitchenRoot);
      if (tcResult.ok) {
        typecheckPassed = true;
        break;
      }

      if (tc === 1 && !courseAgentId) {
        out.warn(
          "inline heal: typecheck failed but no course agent to resume — escalating",
        );
        return {
          outcome: "exhausted",
          restarted: false,
          error: "typecheck failed with no course agent to iterate",
        };
      }

      out.info(`inline heal: typecheck iteration ${tc}/${maxIterations}`);
      const feedback = yield* runInlineCourseAgentTurn({
        apiKey: options.apiKey,
        config: options.config,
        roots: options.roots,
        kitchenRoot: options.kitchenRoot,
        prompt: buildInlineHealTypecheckPrompt({
          kitchenRoot: options.kitchenRoot,
          errors: tcResult.output,
          iteration: tc,
          maxIterations,
        }),
        courseAgentId,
      });
      if (feedback === null) break;
      courseAgentId = feedback.agentId;
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
      const buildResult = yield* runBuild(options.kitchenRoot);
      if (buildResult.ok) {
        buildPassed = true;
        break;
      }

      out.info(`inline heal: build iteration ${bc}/${maxIterations}`);
      const feedback = yield* runInlineCourseAgentTurn({
        apiKey: options.apiKey,
        config: options.config,
        roots: options.roots,
        kitchenRoot: options.kitchenRoot,
        prompt: buildInlineHealBuildPrompt({
          kitchenRoot: options.kitchenRoot,
          errors: buildResult.output,
          iteration: bc,
          maxIterations,
        }),
        courseAgentId,
      });
      if (feedback === null) break;
      courseAgentId = feedback.agentId;
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

    const finalSnapshot = yield* snapshotSrcFiles(options.kitchenRoot);
    const finalChanged = diffSrcSnapshot(options.baseline, finalSnapshot);
    if (finalChanged.length === 0) {
      out.warn("inline heal: typecheck/build passed but src matches baseline");
      return { outcome: "no_changes", restarted: false };
    }

    const patchId = slugifyPatchId(options.issue.key, sessionId);
    const manifest: KitchenPatchManifest = {
      id: patchId,
      issueKey: options.issue.key,
      reason: lastSummary.split("\n")[0]?.slice(0, 200) ?? "inline heal",
      files: finalChanged.map((f) => ({ path: f.path, content: f.content })),
    };

    yield* persistDurableHeal(manifest);
    yield* recordHealInKitchenApplied(options.kitchenRoot, manifest);

    yield* saveHealResume({
      version: 1,
      epic: options.serveHeal.epic,
      issueKey: options.issue.key,
      courseIndex: options.serveHeal.courseIndex,
      serveArgv: options.serveHeal.serveArgv,
      configPath: options.configPath ?? options.serveHeal.configPath,
      courseAgentId,
      trigger: "inline",
      failureDetail:
        options.failureDetail ??
        `Course agent edited issue-dinner source (${finalChanged.length} file(s))`,
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

export const attemptInlineHealFromCourse = (options: {
  issue: JiraIssue;
  config: MachineConfig;
  apiKey: string;
  selfHeal?: boolean;
  kitchenRoot?: string;
  roots: IssueWorkspaces;
  serveHeal?: ServeHealContext;
  baseline?: ReadonlyMap<string, string>;
  courseAgentId?: string;
  failureDetail?: string;
}): Effect.Effect<
  InlineHealResult | undefined,
  unknown,
  FileSystem.FileSystem | CommandExecutor.CommandExecutor
> =>
  Effect.gen(function* () {
    if (
      !options.selfHeal ||
      !options.kitchenRoot ||
      !options.serveHeal ||
      !options.baseline
    ) {
      return undefined;
    }

    return yield* finalizeInlineHeal({
      issue: options.issue,
      kitchenRoot: options.kitchenRoot,
      config: options.config,
      apiKey: options.apiKey,
      roots: options.roots,
      serveHeal: options.serveHeal,
      baseline: options.baseline,
      courseAgentId: options.courseAgentId,
      failureDetail: options.failureDetail,
      configPath: options.serveHeal.configPath,
    });
  });
