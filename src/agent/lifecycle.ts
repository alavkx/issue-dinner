import { Agent } from "@cursor/sdk";
import * as Effect from "effect/Effect";
import type { localAgentOptions } from "../config/workspaces.js";
import { formatAgentError, isSdkCanceledError } from "./sdk-errors.js";

type LocalAgentOptions = ReturnType<typeof localAgentOptions>;

export interface AgentCreateOptions {
  apiKey: string;
  model: { id: string };
  local: LocalAgentOptions;
}

export type CursorAgent = Awaited<ReturnType<typeof Agent.create>>;
export type AgentRun = Awaited<ReturnType<CursorAgent["send"]>>;
export type RunWaitResult = Awaited<ReturnType<AgentRun["wait"]>>;

export const createAgent = (
  options: AgentCreateOptions,
): Effect.Effect<CursorAgent, unknown> =>
  Effect.tryPromise({
    try: () => Agent.create(options),
    catch: (err) => err,
  });

export const resumeAgent = (
  agentId: string,
  options: AgentCreateOptions,
): Effect.Effect<CursorAgent, unknown> =>
  Effect.tryPromise({
    try: () => Agent.resume(agentId, options),
    catch: (err) => err,
  });

export const createOrResumeAgent = (options: {
  resumeAgentId?: string;
  create: AgentCreateOptions;
}): Effect.Effect<CursorAgent, unknown> =>
  options.resumeAgentId
    ? resumeAgent(options.resumeAgentId, options.create)
    : createAgent(options.create);

export const sendPrompt = (
  agent: CursorAgent,
  prompt: string,
): Effect.Effect<AgentRun, unknown> =>
  Effect.tryPromise({
    try: () => agent.send(prompt),
    catch: (err) => err,
  });

export type RunWaitOutcome =
  | { readonly ok: true; readonly value: RunWaitResult }
  | { readonly ok: false; readonly err: unknown };

export const waitForRun = (
  run: AgentRun,
): Effect.Effect<RunWaitOutcome, never> =>
  Effect.tryPromise({
    try: () => run.wait(),
    catch: (err) => err,
  }).pipe(
    Effect.match({
      onFailure: (err) => ({ ok: false as const, err }),
      onSuccess: (value) => ({ ok: true as const, value }),
    }),
  );

export type DisposableAgent = {
  [Symbol.asyncDispose]: () => Promise<void>;
};

export const disposeAgent = (agent: DisposableAgent): Effect.Effect<void> =>
  Effect.tryPromise({
    try: () => agent[Symbol.asyncDispose](),
    catch: (err) => err,
  }).pipe(
    Effect.catchAll((err) => {
      if (!isSdkCanceledError(err)) {
        return Effect.sync(() => {
          console.error(
            `warn: agent dispose failed: ${formatAgentError(err)}`,
          );
        });
      }
      return Effect.void;
    }),
  );

export const withAgent = <A, E, R>(
  acquire: Effect.Effect<CursorAgent, E>,
  use: (agent: CursorAgent) => Effect.Effect<A, unknown, R>,
): Effect.Effect<A, E | unknown, R> =>
  Effect.acquireUseRelease(acquire, use, disposeAgent);
