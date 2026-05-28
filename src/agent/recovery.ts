import { Agent } from "@cursor/sdk";
import type { DinnerConfig } from "../config.js";
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
): Effect.Effect<void, never, StateStore> =>
  Effect.gen(function* () {
    const store = yield* StateStore;
    yield* store.appendResolutionStep(issueKey, step);
    transcript?.appendLine(step);
  });

export const runRecoveryAgent = (options: {
  issue: JiraIssue;
  config: DinnerConfig;
  roots: IssueWorkspaces;
  apiKey: string;
  kind: RecoveryKind;
  detail: string;
  verifyOutput?: string;
  transcript?: Transcript;
  resumeAgentId?: string;
}): Effect.Effect<RecoveryResult, never, StateStore> =>
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
        const agent = yield* Effect.tryPromise({
          try: () =>
            attempt === 1 && options.resumeAgentId
              ? Agent.resume(options.resumeAgentId, {
                  apiKey: options.apiKey,
                  model: { id: options.config.model },
                  local,
                })
              : Agent.create({
                  apiKey: options.apiKey,
                  model: { id: options.config.model },
                  local,
                }),
          catch: (err) => err,
        });

        return yield* Effect.gen(function* () {
          const run = yield* Effect.tryPromise({
            try: () => agent.send(prompt),
            catch: (err) => err,
          });
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
          const drain = yield* Effect.tryPromise({
            try: () => drainRunStream(run.stream(), sink),
            catch: (err) => err,
          });

          const waitResult = yield* Effect.tryPromise({
            try: () => run.wait(),
            catch: (err) => err,
          }).pipe(
            Effect.catchAll((waitErr) =>
              Effect.gen(function* () {
                const msg = formatAgentError(waitErr);
                yield* recordStep(
                  options.issue.key,
                  `Recovery run error: ${msg.slice(0, 200)}`,
                  options.transcript,
                );
                return null;
              }),
            ),
          );

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
        }).pipe(
          Effect.ensuring(
            Effect.tryPromise({
              try: () => safeDisposeAgent(agent),
              catch: () => undefined,
            }).pipe(Effect.ignore),
          ),
        );
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
  config: DinnerConfig;
  transcript?: Transcript;
}): Effect.Effect<boolean, unknown, StateStore> =>
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
    const results = yield* Effect.tryPromise({
      try: () =>
        recoverDirtyWorkspaces(
          options.issue.key,
          options.issue.summary,
          workspaces,
        ),
      catch: (err) => err,
    });
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
  config: DinnerConfig;
  stack: StackConfig;
  apiKey: string;
  transcript?: Transcript;
}): Effect.Effect<StackActionSummary[], unknown, StateStore> =>
  Effect.gen(function* () {
    const port = createGraphiteStackPort();

    const checkout = () =>
      Effect.tryPromise({
        try: () =>
          checkoutIssueStack(
            options.issue,
            options.config,
            options.stack,
            port,
          ),
        catch: (err) => err,
      });

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
          options.transcript?.appendBlock("stack prep failed", detail);
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
