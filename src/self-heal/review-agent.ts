import type { MachineConfig } from "../config.js";
import { healAgentOptions } from "../config/workspaces.js";
import {
  createAgent,
  disposeAgent,
  sendPrompt,
  waitForRun,
} from "../agent/lifecycle.js";
import { drainRunStream } from "../agent/stream-handler.js";
import { formatAgentError } from "../agent/sdk-errors.js";
import * as FileSystem from "@effect/platform/FileSystem";
import type * as CommandExecutor from "@effect/platform/CommandExecutor";
import * as Effect from "effect/Effect";
import * as out from "../ui/out.js";
import { join } from "node:path";
import { contributeAppliedPatches, listPendingContributions, readAppliedManifest } from "./contribute.js";
import { healAppliedDir } from "./patch.js";
import type { HealPatchManifest } from "./patch.js";

export const REVIEW_APPROVE_MARKER = "HEAL_REVIEW_APPROVE";
export const REVIEW_REJECT_MARKER = "HEAL_REVIEW_REJECT";

export interface HealReviewResult {
  readonly approved: ReadonlyArray<string>;
  readonly rejected: ReadonlyArray<string>;
  readonly contributed: ReadonlyArray<string>;
  readonly skipped: boolean;
}

const buildReviewPrompt = (
  manifests: ReadonlyArray<HealPatchManifest>,
  baseBranch: string,
): string => {
  const patchList = manifests
    .map(
      (m) =>
        `- **${m.id}** (from ${m.issueKey ?? "?"}): ${m.reason ?? "no reason"}\n  Files: ${m.files.map((f) => f.path).join(", ")}`,
    )
    .join("\n");

  return `## Heal review — upstream contribution gate

You are reviewing **issue-dinner self-heal patches** from this serve run before they are contributed to \`${baseBranch}\`.

### Patches to review
${patchList || "(none)"}

### Task
For each patch id, decide if it is worth merging upstream:
- Focused fix for a real issue-dinner bug discovered during serve
- Minimal scope (only \`src/**/*.ts\`)
- Not a workaround for project-specific or environmental issues

Reply in this exact format:

\`\`\`
${REVIEW_APPROVE_MARKER}: patch-id-1, patch-id-2
${REVIEW_REJECT_MARKER}: patch-id-3
\`\`\`

Omit ids you are unsure about — they will not be contributed.
If none should merge, use \`${REVIEW_REJECT_MARKER}: all\`.
`;
};

export function parseReviewDecision(text: string): {
  approved: string[];
  rejected: string[];
} {
  const approved: string[] = [];
  const rejected: string[] = [];
  const approveLine = text
    .split("\n")
    .find((l) => l.includes(REVIEW_APPROVE_MARKER));
  const rejectLine = text
    .split("\n")
    .find((l) => l.includes(REVIEW_REJECT_MARKER));

  if (approveLine) {
    const part = approveLine.split(":").slice(1).join(":").trim();
    for (const id of part.split(",")) {
      const t = id.trim();
      if (t && t !== "all") approved.push(t);
    }
  }
  if (rejectLine) {
    const part = rejectLine.split(":").slice(1).join(":").trim();
    if (part.toLowerCase() === "all") {
      return { approved, rejected: ["__all__"] };
    }
    for (const id of part.split(",")) {
      const t = id.trim();
      if (t) rejected.push(t);
    }
  }
  return { approved, rejected };
}

export const runHealReviewAgent = (options: {
  toolRoot: string;
  config: MachineConfig;
  apiKey: string;
  manifests: ReadonlyArray<HealPatchManifest>;
  baseBranch?: string;
}): Effect.Effect<
  { approved: string[]; rejected: string[] },
  unknown,
  FileSystem.FileSystem | CommandExecutor.CommandExecutor
> =>
  Effect.gen(function* () {
    const manifests = options.manifests;
    if (manifests.length === 0) {
      return { approved: [], rejected: [] };
    }

    const baseBranch =
      options.baseBranch ??
      process.env.ISSUE_DINNER_CONTRIBUTE_BASE?.trim() ??
      "main";

    const local = healAgentOptions(options.config, options.toolRoot);
    const agent = yield* createAgent({
      apiKey: options.apiKey,
      model: { id: options.config.model },
      local,
    });

    const decision = yield* Effect.gen(function* () {
      const run = yield* sendPrompt(
        agent,
        buildReviewPrompt(manifests, baseBranch),
      );
      out.phase("heal review", `agentId=${agent.agentId}`);
      yield* drainRunStream(run.stream(), {
        writeStdout: (t) => process.stdout.write(t),
        writeStderr: (t) => process.stderr.write(t),
      });
      const waitOutcome = yield* waitForRun(run);
      if (!waitOutcome.ok) {
        out.warn(`heal review: ${formatAgentError(waitOutcome.err)}`);
        return { approved: [] as string[], rejected: [] as string[] };
      }
      const text = waitOutcome.value.result ?? "";
      return parseReviewDecision(text);
    }).pipe(Effect.ensuring(disposeAgent(agent)));

    const pendingIds = manifests.map((m) => m.id);
    if (decision.rejected.includes("__all__")) {
      return { approved: [], rejected: pendingIds };
    }

    const approved =
      decision.approved.length > 0
        ? decision.approved.filter((id) => pendingIds.includes(id))
        : pendingIds.filter((id) => !decision.rejected.includes(id));

    return {
      approved,
      rejected: decision.rejected.filter((id) => pendingIds.includes(id)),
    };
  });

export const reviewAndContributeHeals = (options: {
  toolRoot: string;
  config: MachineConfig;
  apiKey: string;
  dryRun?: boolean;
}): Effect.Effect<
  HealReviewResult,
  unknown,
  FileSystem.FileSystem | CommandExecutor.CommandExecutor | import("./contribute.js").SelfHealGitPort
> =>
  Effect.gen(function* () {
    const pendingNames = yield* listPendingContributions(options.toolRoot);
    if (pendingNames.length === 0) {
      return { approved: [], rejected: [], contributed: [], skipped: true };
    }

    const manifests: HealPatchManifest[] = [];
    for (const name of pendingNames) {
      const patchDir = join(healAppliedDir(options.toolRoot), name);
      const manifest = yield* readAppliedManifest(patchDir).pipe(
        Effect.catchAll(() => Effect.succeed(undefined)),
      );
      if (manifest) manifests.push(manifest);
    }
    if (manifests.length === 0) {
      return { approved: [], rejected: [], contributed: [], skipped: true };
    }

    const review = yield* runHealReviewAgent({ ...options, manifests });
    const contributed: string[] = [];

    for (const patchId of review.approved) {
      const result = yield* contributeAppliedPatches({
        root: options.toolRoot,
        dryRun: options.dryRun,
        patchId,
      }).pipe(
        Effect.catchAll((err) =>
          Effect.succeed({
            contributed: [] as string[],
            skipped: [] as string[],
            failed: [{ patchId, error: String(err) }],
          }),
        ),
      );
      contributed.push(...result.contributed);
      if (result.failed.length > 0) {
        out.warn(
          `heal contribute ${patchId}: ${result.failed[0]?.error ?? "failed"}`,
        );
      }
    }

    if (review.rejected.length > 0) {
      out.info(`heal review rejected: ${review.rejected.join(", ")}`);
    }
    if (contributed.length > 0) {
      out.success(`heal review contributed: ${contributed.join(", ")}`);
    }

    return {
      approved: review.approved,
      rejected: review.rejected,
      contributed,
      skipped: false,
    };
  });
