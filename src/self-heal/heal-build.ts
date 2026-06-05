import * as FileSystem from "@effect/platform/FileSystem";
import type * as CommandExecutor from "@effect/platform/CommandExecutor";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { resolveProjectRoot } from "../runtime/project-root.js";
import { runCommand } from "../util/exec.js";
import { HealApplyFailed } from "./patch.js";
import { listDurableHealManifests } from "./durable-patches.js";
import { listPendingContributions } from "./contribute.js";

export interface SelfHealBuildCommands {
  readonly validate: (
    root: string,
    patchId: string,
  ) => Effect.Effect<
    void,
    HealApplyFailed,
    CommandExecutor.CommandExecutor
  >;
}

export class SelfHealBuildPort extends Context.Tag("issue-dinner/SelfHealBuildPort")<
  SelfHealBuildPort,
  SelfHealBuildCommands
>() {}

export const SelfHealBuildPortLive = Layer.succeed(SelfHealBuildPort, {
  validate: (root, patchId) =>
    Effect.gen(function* () {
      yield* runCommand("npm", ["run", "typecheck"], { cwd: root }).pipe(
        Effect.mapError(
          (err) =>
            new HealApplyFailed({
              patchId,
              message:
                "message" in err
                  ? String(err.message)
                  : `typecheck failed for patch ${patchId}`,
            }),
        ),
      );
      yield* runCommand("npm", ["run", "build"], { cwd: root }).pipe(
        Effect.mapError(
          (err) =>
            new HealApplyFailed({
              patchId,
              message:
                "message" in err
                  ? String(err.message)
                  : `build failed for patch ${patchId}`,
            }),
        ),
      );
    }),
});

export interface HealStatus {
  readonly root: string;
  readonly durable: ReadonlyArray<{
    readonly id: string;
    readonly issueKey?: string;
    readonly reason?: string;
    readonly fileCount: number;
  }>;
  readonly pendingContribution: ReadonlyArray<string>;
}

export const getHealStatus = (): Effect.Effect<
  HealStatus,
  import("@effect/platform/Error").PlatformError,
  FileSystem.FileSystem
> =>
  Effect.gen(function* () {
    const root = yield* resolveProjectRoot();
    const manifests = yield* listDurableHealManifests();
    return {
      root,
      durable: manifests.map((m) => ({
        id: m.id,
        issueKey: m.issueKey,
        reason: m.reason,
        fileCount: m.files.length,
      })),
      pendingContribution: yield* listPendingContributions(root),
    };
  });

export const formatHealStatus = (status: HealStatus): string => {
  const lines = [
    `issue-dinner root: ${status.root}`,
    `Durable heals (${status.durable.length}):`,
  ];
  if (status.durable.length === 0) {
    lines.push("  (none)");
  } else {
    for (const patch of status.durable) {
      const meta = [
        patch.issueKey ? `from ${patch.issueKey}` : undefined,
        patch.reason,
        `${patch.fileCount} file(s)`,
      ]
        .filter(Boolean)
        .join(" — ");
      lines.push(`  • ${patch.id}${meta ? ` (${meta})` : ""}`);
    }
  }
  lines.push(
    `Pending upstream PR: ${status.pendingContribution.length ? status.pendingContribution.join(", ") : "(none)"}`,
  );
  return lines.join("\n");
};
