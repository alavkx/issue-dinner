import type { MachineConfig } from "../config.js";
import { healAgentOptions } from "../config/workspaces.js";
import type { JiraIssue } from "../jira/acli.js";
import { CommandFailed } from "../effect/errors.js";
import { runCommand } from "../util/exec.js";
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
  persistDurableHeal,
  recordHealInKitchenApplied,
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
import type { KitchenPatchManifest } from "./patch.js";

export interface HealSessionOptions {
  readonly issue: JiraIssue;
  readonly kitchenRoot: string;
  readonly config: MachineConfig;
  readonly apiKey: string;
  readonly trigger: HealTriggerKind;
  readonly detail: string;
  readonly verifyOutput?: string;
  readonly serveArgv: ReadonlyArray<string>;
  readonly epic: string;
  readonly courseIndex: number;
  readonly configPath?: string;
  readonly courseAgentId?: string;
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

const formatCommandFailure = (err: unknown): string => {
  if (err instanceof CommandFailed) {
    return [err.stderr, err.stdout, err.message].filter(Boolean).join("\n");
  }
  return err instanceof Error ? err.message : String(err);
};

const runTypecheck = (
  root: string,
): Effect.Effect<
  { ok: true } | { ok: false; output: string },
  import("@effect/platform/Error").PlatformError,
  CommandExecutor.CommandExecutor
> =>
  runCommand("npm", ["run", "typecheck"], { cwd: root }).pipe(
    Effect.map(() => ({ ok: true as const })),
    Effect.catchAll((err) =>
      Effect.succeed({ ok: false as const, output: formatCommandFailure(err) }),
    ),
  );

const runBuild = (
  root: string,
): Effect.Effect<
  { ok: true } | { ok: false; output: string },
  import("@effect/platform/Error").PlatformError,
  CommandExecutor.CommandExecutor
> =>
  runCommand("npm", ["run", "build"], { cwd: root }).pipe(
    Effect.map(() => ({ ok: true as const })),
    Effect.catchAll((err) =>
      Effect.succeed({ ok: false as const, output: formatCommandFailure(err) }),
    ),
  );

const runHealAgentTurn = (options: {
  apiKey: string;
  config: MachineConfig;
  kitchenRoot: string;
  prompt: string;
  resumeHealAgentId?: string;
}): Effect.Effect<
  { agentId: string; text: string; declined: boolean } | null,
  unknown,
  FileSystem.FileSystem | CommandExecutor.CommandExecutor
> =>
  Effect.gen(function* () {
    const local = healAgentOptions(options.config, options.kitchenRoot);
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
    const maxHealAttempts = options.config.healAttempts ?? 3;
    const maxTypecheckIterations = options.config.healTypecheckIterations ?? 8;
    const sessionId = buildHealSessionId(options.issue.key);
    const baseline = yield* snapshotSrcFiles(options.kitchenRoot);

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
        kitchenRoot: options.kitchenRoot,
        trigger: options.trigger,
        detail: options.detail,
        verifyOutput: options.verifyOutput,
        attempt: healAttempt,
        maxAttempts: maxHealAttempts,
      });

      const firstTurn = yield* runHealAgentTurn({
        apiKey: options.apiKey,
        config: options.config,
        kitchenRoot: options.kitchenRoot,
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
        const tcResult = yield* runTypecheck(options.kitchenRoot);
        if (tcResult.ok) {
          typecheckPassed = true;
          break;
        }

        out.info(`heal: typecheck iteration ${tc}/${maxTypecheckIterations}`);
        const feedback: { agentId: string; text: string; declined: boolean } | null =
          yield* runHealAgentTurn({
          apiKey: options.apiKey,
          config: options.config,
          kitchenRoot: options.kitchenRoot,
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
        const buildResult = yield* runBuild(options.kitchenRoot);
        if (buildResult.ok) {
          buildPassed = true;
          break;
        }

        out.info(`heal: build iteration ${bc}/${maxTypecheckIterations}`);
        const feedback: { agentId: string; text: string; declined: boolean } | null =
          yield* runHealAgentTurn({
          apiKey: options.apiKey,
          config: options.config,
          kitchenRoot: options.kitchenRoot,
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

      const current = yield* snapshotSrcFiles(options.kitchenRoot);
      const changed = diffSrcSnapshot(baseline, current);
      if (changed.length === 0) {
        out.warn("heal: typecheck/build passed but no src changes detected");
        return { outcome: "no_changes", restarted: false };
      }

      patchId = slugifyPatchId(options.issue.key, sessionId);
      const manifest: KitchenPatchManifest = {
        id: patchId,
        issueKey: options.issue.key,
        reason: lastSummary.split("\n")[0]?.slice(0, 200) ?? options.trigger,
        files: changed.map((f) => ({ path: f.path, content: f.content })),
      };

      yield* persistDurableHeal(manifest);
      yield* recordHealInKitchenApplied(options.kitchenRoot, manifest);

      yield* saveHealResume({
        version: 1,
        epic: options.epic,
        issueKey: options.issue.key,
        courseIndex: options.courseIndex,
        serveArgv: options.serveArgv,
        configPath: options.configPath,
        courseAgentId: options.courseAgentId,
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
  readonly courseIndex: number;
  readonly epic: string;
  readonly configPath?: string;
}

export const attemptSelfHealFromCourse = (options: {
  issue: JiraIssue;
  config: MachineConfig;
  apiKey: string;
  selfHeal?: boolean;
  kitchenRoot?: string;
  serveHeal?: ServeHealContext;
  trigger: HealTriggerKind;
  detail: string;
  verifyOutput?: string;
  courseAgentId?: string;
}): Effect.Effect<
  HealSessionResult | undefined,
  unknown,
  FileSystem.FileSystem | CommandExecutor.CommandExecutor
> =>
  Effect.gen(function* () {
    if (!options.selfHeal || !options.kitchenRoot || !options.serveHeal) {
      return undefined;
    }

    out.phase("self-heal", `${options.issue.key} — ${options.trigger}`);
    const result = yield* trySelfHeal({
      issue: options.issue,
      kitchenRoot: options.kitchenRoot,
      config: options.config,
      apiKey: options.apiKey,
      trigger: options.trigger,
      detail: options.detail,
      verifyOutput: options.verifyOutput,
      serveArgv: options.serveHeal.serveArgv,
      epic: options.serveHeal.epic,
      courseIndex: options.serveHeal.courseIndex,
      configPath: options.serveHeal.configPath,
      courseAgentId: options.courseAgentId,
    });

    if (result.outcome === "declined") {
      out.info(`self-heal: heal agent declined for ${options.issue.key}`);
    } else if (result.outcome === "exhausted") {
      out.warn(`self-heal: ${result.error ?? "heal exhausted"}`);
    }

    return result;
  });
