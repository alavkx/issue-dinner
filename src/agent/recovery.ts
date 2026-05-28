import type { MachineConfig } from "../config.js";
import type { StackConfig } from "../stack/stack-config.js";
import {
  localAgentOptions,
  resolveIssueWorkspaces,
  type IssueWorkspaces,
} from "../config/workspaces.js";
import type { JiraIssue } from "../jira/acli.js";
import { StateStore } from "../state/store.js";
import { recoverDirtyWorkspaces } from "../git/recover-workspace.js";
import { checkoutIssueStack } from "../stack/prep.js";
import { createGraphiteStackPort } from "../stack/graphite-runner.js";
import type { StackActionSummary } from "../stack/prep.js";
import * as out from "../ui/out.js";
import { drainRunStream } from "./stream-handler.js";
import { formatAgentError, isSdkCanceledError } from "./sdk-errors.js";
import {
  createOrResumeAgent,
  disposeAgent,
  sendPrompt,
  waitForRun,
} from "./lifecycle.js";
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
import { appendTranscript, appendTranscriptBlock, appendTranscriptLine } from "../serve/transcript.js";
import * as FileSystem from "@effect/platform/FileSystem";
import * as Effect from "effect/Effect";

export interface RecoveryResult {
  recovered: boolean;
  handoff?: ParsedHandoff;
  agentId?: string;
  runId?: string;
  resultText?: string;
  error?: string;
}

const recordStep = (
  issueKey: string,
  step: string,
  transcript?: Transcript,
): Effect.Effect<void, import("@effect/platform/Error").PlatformError, StateStore | FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const store = yield* StateStore;
    yield* store.appendResolutionStep(issueKey, step);
    if (transcript) yield* appendTranscriptLine(transcript, step);
  });

export const runRecoveryAgent = (options: {
  issue: JiraIssue;
  config: MachineConfig;
  roots: IssueWorkspaces;
  apiKey: string;
  kind: RecoveryKind;
  detail: string;
  verifyOutput?: string;
  transcript?: Transcript;
  resumeAgentId?: string;
}): Effect.Effect<
  RecoveryResult,
  import("@effect/platform/Error").PlatformError,
  StateStore | FileSystem.FileSystem
> =>
  Effect.gen(function* () {
    const max = options.config.recoveryAttempts ?? 2;
    const local = localAgentOptions(options.config, options.roots.cwds);

    for (let attempt = 1; attempt <= max; attempt++) {
      const step = `Recovery ${options.kind} attempt ${attempt}/${max}`;
      out.warn(`${options.issue.key}: ${step}`);
      yield* recordStep(options.issue.key, step, options.transcript);

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

      const attemptResult = yield* Effect.gen(function* () {
        const agent = yield* createOrResumeAgent({
          resumeAgentId:
            attempt === 1 ? options.resumeAgentId : undefined,
          create: {
            apiKey: options.apiKey,
            model: { id: options.config.model },
            local,
          },
        });

        return yield* Effect.gen(function* () {
          const run = yield* sendPrompt(agent, prompt);
          out.phase("recovery stream", `${options.issue.key} agent=${agent.agentId}`);

          const sink = {
            writeStdout: quietRecovery
              ? () => {}
              : (t: string) => process.stdout.write(t),
            writeStderr: quietRecovery
              ? () => {}
              : (t: string) => process.stderr.write(t),
            appendTranscript: options.transcript
              ? (t: string) => appendTranscript(options.transcript!, t)
              : undefined,
          };
          const drain = yield* drainRunStream(run.stream(), sink);

          let waitResult;
          const waitOutcome = yield* waitForRun(run);
          if (!waitOutcome.ok) {
            const msg = formatAgentError(waitOutcome.err);
            yield* recordStep(
              options.issue.key,
              `Recovery run error: ${msg.slice(0, 200)}`,
              options.transcript,
            );
            waitResult = null;
          } else {
            waitResult = waitOutcome.value;
          }

          if (waitResult === null) {
            return null;
          }

          const result = waitResult;

          if (drain.canceled || result.status === "cancelled") {
            yield* recordStep(
              options.issue.key,
              "Recovery agent canceled (stall timeout or abort)",
              options.transcript,
            );
            return null;
          }

          if (result.status === "error") {
            const msg = result.result ?? result.status;
            yield* recordStep(
              options.issue.key,
              `Recovery run ${result.status}: ${msg.slice(0, 200)}`,
              options.transcript,
            );
            return null;
          }

          const text = result.result ?? "";
          const handoff = parseHandoff(text);
          if (!agentPhaseSucceeded(handoff)) {
            yield* recordStep(
              options.issue.key,
              `Recovery handoff not acceptable (status=${handoff.status})`,
              options.transcript,
            );
            return null;
          }

          yield* recordStep(
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
          } satisfies RecoveryResult;
        }).pipe(Effect.ensuring(disposeAgent(agent)));
      }).pipe(
        Effect.catchAll((err) =>
          Effect.gen(function* () {
            const msg = formatAgentError(err);
            const step = isSdkCanceledError(err)
              ? "Recovery agent canceled (stall timeout or abort)"
              : `Recovery agent error: ${msg.slice(0, 200)}`;
            yield* recordStep(options.issue.key, step, options.transcript);
            return null;
          }),
        ),
      );

      if (attemptResult !== null) {
        return attemptResult;
      }
    }

    return { recovered: false, error: `Recovery exhausted after ${max} attempt(s)` };
  });

const tryProgrammaticStackRecovery = (options: {
  issue: JiraIssue;
  config: MachineConfig;
  transcript?: Transcript;
}): Effect.Effect<
  boolean,
  unknown,
  | StateStore
  | import("@effect/platform/CommandExecutor").CommandExecutor
  | FileSystem.FileSystem
> =>
  Effect.gen(function* () {
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
    const results = yield* recoverDirtyWorkspaces(
      options.issue.key,
      options.issue.summary,
      workspaces,
    );
    const ok = results.every((r) => r.ok);
    if (ok && results.some((r) => r.action !== "already_clean")) {
      yield* recordStep(
        options.issue.key,
        `Programmatic stack recovery: ${results.map((r) => r.action).join(", ")}`,
        options.transcript,
      );
    }
    return ok;
  });

export const checkoutWithRecovery = (options: {
  issue: JiraIssue;
  config: MachineConfig;
  stack: StackConfig;
  apiKey: string;
  transcript?: Transcript;
}): Effect.Effect<
  StackActionSummary[],
  unknown,
  | StateStore
  | import("@effect/platform/CommandExecutor").CommandExecutor
  | FileSystem.FileSystem
> =>
  Effect.gen(function* () {
    const port = createGraphiteStackPort();

    const checkout = () =>
      checkoutIssueStack(
        options.issue,
        options.config,
        options.stack,
        port,
      );

    const first = yield* checkout().pipe(
      Effect.catchAll((err) =>
        Effect.gen(function* () {
          const detail = err instanceof Error ? err.message : String(err);
          if (detail.includes("working tree is dirty")) {
            const cleaned = yield* tryProgrammaticStackRecovery(options);
            if (cleaned) {
              out.success("Programmatic workspace recovery — retrying checkout");
              const retry = yield* checkout().pipe(
                Effect.match({
                  onFailure: (retryErr) => {
                    const retryDetail =
                      retryErr instanceof Error
                        ? retryErr.message
                        : String(retryErr);
                    out.error(`Stack prep still failed: ${retryDetail}`);
                    return undefined;
                  },
                  onSuccess: (value) => value,
                }),
              );
              if (retry !== undefined) {
                return retry;
              }
            }
          }

          out.error(`Stack prep failed: ${detail}`);
          if (options.transcript) {
            yield* appendTranscriptBlock(
              options.transcript,
              "stack prep failed",
              detail,
            );
          }
          yield* recordStep(
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

          yield* tryProgrammaticStackRecovery(options);
          out.success("Programmatic recovery — retrying checkout");
          const programmaticRetry = yield* checkout().pipe(
            Effect.match({
              onFailure: () => undefined,
              onSuccess: (value) => value,
            }),
          );
          if (programmaticRetry !== undefined) {
            return programmaticRetry;
          }

          const recovery = yield* runRecoveryAgent({
            issue: options.issue,
            config: options.config,
            roots,
            apiKey: options.apiKey,
            kind: "stack_prep",
            detail,
            transcript: options.transcript,
          });

          yield* tryProgrammaticStackRecovery(options);
          const finalCheckout = yield* checkout().pipe(
            Effect.match({
              onFailure: (retryErr) => ({ ok: false as const, err: retryErr }),
              onSuccess: (value) => ({ ok: true as const, value }),
            }),
          );
          if (finalCheckout.ok) {
            return finalCheckout.value;
          }

          const retryDetail =
            finalCheckout.err instanceof Error
              ? finalCheckout.err.message
              : String(finalCheckout.err);
          yield* recordStep(
            options.issue.key,
            `Stack prep still failed: ${retryDetail.slice(0, 300)}`,
            options.transcript,
          );
          return yield* Effect.fail(err);
        }),
      ),
    );

    return first;
  });
