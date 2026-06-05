import type { MachineConfig } from "../config.js";
import { healAgentOptions } from "../config/workspaces.js";
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
import {
  diffSrcSnapshot,
  manifestLooksForeign,
  persistDurableHeal,
  recordHealApplied,
  snapshotSrcFiles,
} from "./durable-patches.js";
import {
  agentDeclinedHeal,
  buildHealBuildPrompt,
  buildHealPrompt,
  buildHealTypecheckPrompt,
  extractHealSummary,
} from "./heal-prompt.js";
import {
  buildHealSessionId,
  type HealTriggerKind,
  saveHealResume,
} from "./heal-resume.js";
import type { HealPatchManifest } from "./patch.js";
import { isIssueDinnerPackageRoot, readPackageName, runBuild, runTypecheck } from "./heal-validation.js";

export interface HealSessionOptions {
  readonly issue: JiraIssue;
  readonly toolRoot: string;
  readonly config: MachineConfig;
  readonly apiKey: string;
  readonly trigger: HealTriggerKind;
  readonly detail: string;
  readonly verifyOutput?: string;
  readonly serveArgv: ReadonlyArray<string>;
  readonly epic: string;
  readonly storyIndex: number;
  readonly configPath?: string;
  readonly storyAgentId?: string;
  readonly resumeHealAgentId?: string;
}

export interface HealSessionResult {
  readonly outcome: "healed" | "declined" | "exhausted" | "no_changes";
  readonly patchId?: string;
  readonly fixSummary?: string;
  readonly restarted: boolean;
  readonly error?: string;
}

const slugifyPatchId = (issueKey: string, sessionId: string): string => {
  const tail = sessionId.split("-").pop() ?? "0";
  return `heal-${issueKey.toLowerCase()}-${tail}`;
};

const runHealAgentTurn = (options: {
  apiKey: string;
  config: MachineConfig;
  toolRoot: string;
  prompt: string;
  resumeHealAgentId?: string;
}): Effect.Effect<
  { agentId: string; text: string; declined: boolean } | null,
  unknown,
  FileSystem.FileSystem | CommandExecutor.CommandExecutor
> =>
  Effect.gen(function* () {
    const local = healAgentOptions(options.config, options.toolRoot);
    const agent = yield* createOrResumeAgent({
      resumeAgentId: options.resumeHealAgentId,
      create: {
        apiKey: options.apiKey,
        model: { id: options.config.model },
        local,
      },
    });

    const result = yield* Effect.gen(function* () {
      const run = yield* sendPrompt(agent, options.prompt);
      out.phase("heal stream", `agentId=${agent.agentId} runId=${run.id}`);
      yield* drainRunStream(run.stream(), {
        writeStdout: (t) => process.stdout.write(t),
        writeStderr: (t) => process.stderr.write(t),
      });
      const waitOutcome = yield* waitForRun(run);
      if (!waitOutcome.ok) {
        out.warn(`heal agent wait: ${formatAgentError(waitOutcome.err)}`);
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

export const runHealSession = (
  options: HealSessionOptions,
): Effect.Effect<
  HealSessionResult,
  unknown,
  FileSystem.FileSystem | CommandExecutor.CommandExecutor
> =>
  Effect.gen(function* () {
    const isIssueDinnerRoot = yield* isIssueDinnerPackageRoot(options.toolRoot);
    if (!isIssueDinnerRoot) {
      const packageName = yield* readPackageName(options.toolRoot);
      out.warn(
        `heal: skipping — toolRoot is ${packageName ?? "unknown"} at ${options.toolRoot}, not issue-dinner`,
      );
      return { outcome: "no_changes", restarted: false };
    }

    const maxHealAttempts = options.config.healAttempts ?? 3;
    const maxTypecheckIterations = options.config.healTypecheckIterations ?? 8;
    const sessionId = buildHealSessionId(options.issue.key);
    const baseline = yield* snapshotSrcFiles(options.toolRoot);

    let healAgentId: string | undefined = options.resumeHealAgentId;
    let lastSummary = "";
    let patchId = slugifyPatchId(options.issue.key, sessionId);

    for (let healAttempt = 1; healAttempt <= maxHealAttempts; healAttempt++) {
      out.phase(
        "heal",
        `${options.issue.key} attempt ${healAttempt}/${maxHealAttempts} (${options.trigger})`,
      );

      const initialPrompt = buildHealPrompt({
        issue: options.issue,
        toolRoot: options.toolRoot,
        trigger: options.trigger,
        detail: options.detail,
        verifyOutput: options.verifyOutput,
        attempt: healAttempt,
        maxAttempts: maxHealAttempts,
      });

      const firstTurn = yield* runHealAgentTurn({
        apiKey: options.apiKey,
        config: options.config,
        toolRoot: options.toolRoot,
        prompt: initialPrompt,
        resumeHealAgentId: healAttempt === 1 ? healAgentId : undefined,
      });

      if (firstTurn === null) {
        continue;
      }

      healAgentId = firstTurn.agentId;
      lastSummary = extractHealSummary(firstTurn.text);

      if (firstTurn.declined) {
        out.info(`heal: agent declined (${options.issue.key})`);
        return { outcome: "declined", restarted: false };
      }

      let typecheckPassed = false;
      for (let tc = 1; tc <= maxTypecheckIterations; tc++) {
        const tcResult = yield* runTypecheck(options.toolRoot);
        if (tcResult.ok) {
          typecheckPassed = true;
          break;
        }

        out.info(`heal: typecheck iteration ${tc}/${maxTypecheckIterations}`);
        const feedback: { agentId: string; text: string; declined: boolean } | null =
          yield* runHealAgentTurn({
          apiKey: options.apiKey,
          config: options.config,
          toolRoot: options.toolRoot,
          prompt: buildHealTypecheckPrompt({
            errors: tcResult.output,
            iteration: tc,
            maxIterations: maxTypecheckIterations,
          }),
          resumeHealAgentId: healAgentId,
        });
        if (feedback === null) break;
        healAgentId = feedback.agentId;
        lastSummary = extractHealSummary(feedback.text);
        if (feedback.declined) {
          return { outcome: "declined", restarted: false };
        }
      }

      if (!typecheckPassed) {
        continue;
      }

      let buildPassed = false;
      for (let bc = 1; bc <= maxTypecheckIterations; bc++) {
        const buildResult = yield* runBuild(options.toolRoot);
        if (buildResult.ok) {
          buildPassed = true;
          break;
        }

        out.info(`heal: build iteration ${bc}/${maxTypecheckIterations}`);
        const feedback: { agentId: string; text: string; declined: boolean } | null =
          yield* runHealAgentTurn({
          apiKey: options.apiKey,
          config: options.config,
          toolRoot: options.toolRoot,
          prompt: buildHealBuildPrompt({
            errors: buildResult.output,
            iteration: bc,
            maxIterations: maxTypecheckIterations,
          }),
          resumeHealAgentId: healAgentId,
        });
        if (feedback === null) break;
        healAgentId = feedback.agentId;
        lastSummary = extractHealSummary(feedback.text);
        if (feedback.declined) {
          return { outcome: "declined", restarted: false };
        }
      }

      if (!buildPassed) {
        continue;
      }

      const current = yield* snapshotSrcFiles(options.toolRoot);
      const changed = diffSrcSnapshot(baseline, current);
      if (changed.length === 0) {
        out.warn("heal: typecheck/build passed but no src changes detected");
        return { outcome: "no_changes", restarted: false };
      }

      patchId = slugifyPatchId(options.issue.key, sessionId);
      const packageName = yield* readPackageName(options.toolRoot);
      const manifest: HealPatchManifest = {
        id: patchId,
        issueKey: options.issue.key,
        packageName: packageName ?? undefined,
        reason: lastSummary.split("\n")[0]?.slice(0, 200) ?? options.trigger,
        files: changed.map((f) => ({ path: f.path, content: f.content })),
      };

      if (manifestLooksForeign(manifest)) {
        out.warn(
          "heal: refusing to persist — src changes look like project workspace edits, not issue-dinner",
        );
        return { outcome: "no_changes", restarted: false };
      }

      yield* persistDurableHeal(manifest);
      yield* recordHealApplied(options.toolRoot, manifest);

      yield* saveHealResume({
        version: 1,
        epic: options.epic,
        issueKey: options.issue.key,
        storyIndex: options.storyIndex,
        serveArgv: options.serveArgv,
        configPath: options.configPath,
        storyAgentId: options.storyAgentId,
        healAgentId,
        trigger: options.trigger,
        failureDetail: options.detail,
        healSessionId: sessionId,
        patchId,
        fixSummary: lastSummary,
        postHealResume: true,
      });

      out.success(`heal: patched ${changed.length} file(s) — restarting`);
      yield* requestRestart(options.serveArgv);
      return {
        outcome: "healed",
        patchId,
        fixSummary: lastSummary,
        restarted: true,
      };
    }

    return {
      outcome: "exhausted",
      restarted: false,
      error: `Heal exhausted after ${maxHealAttempts} attempt(s)`,
    };
  });

export const trySelfHeal = (
  options: HealSessionOptions,
): Effect.Effect<
  HealSessionResult,
  unknown,
  FileSystem.FileSystem | CommandExecutor.CommandExecutor
> => runHealSession(options);

export interface ServeHealContext {
  readonly serveArgv: ReadonlyArray<string>;
  readonly storyIndex: number;
  readonly epic: string;
  readonly configPath?: string;
}

export const attemptSelfHealFromStory = (options: {
  issue: JiraIssue;
  config: MachineConfig;
  apiKey: string;
  selfHeal?: boolean;
  toolRoot?: string;
  serveHeal?: ServeHealContext;
  trigger: HealTriggerKind;
  detail: string;
  verifyOutput?: string;
  storyAgentId?: string;
}): Effect.Effect<
  HealSessionResult | undefined,
  unknown,
  FileSystem.FileSystem | CommandExecutor.CommandExecutor
> =>
  Effect.gen(function* () {
    if (!options.selfHeal || !options.toolRoot || !options.serveHeal) {
      return undefined;
    }

    out.phase("self-heal", `${options.issue.key} — ${options.trigger}`);
    const result = yield* trySelfHeal({
      issue: options.issue,
      toolRoot: options.toolRoot,
      config: options.config,
      apiKey: options.apiKey,
      trigger: options.trigger,
      detail: options.detail,
      verifyOutput: options.verifyOutput,
      serveArgv: options.serveHeal.serveArgv,
      epic: options.serveHeal.epic,
      storyIndex: options.serveHeal.storyIndex,
      configPath: options.serveHeal.configPath,
      storyAgentId: options.storyAgentId,
    });

    if (result.outcome === "declined") {
      out.info(`self-heal: heal agent declined for ${options.issue.key}`);
    } else if (result.outcome === "exhausted") {
      out.warn(`self-heal: ${result.error ?? "heal exhausted"}`);
    }

    return result;
  });
