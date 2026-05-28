import { join } from "node:path";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export class KitchenPatchInvalid extends Schema.TaggedError<KitchenPatchInvalid>()(
  "KitchenPatchInvalid",
  {
    message: Schema.String,
    patchId: Schema.optional(Schema.String),
  },
) {}

export class KitchenApplyFailed extends Schema.TaggedError<KitchenApplyFailed>()(
  "KitchenApplyFailed",
  {
    message: Schema.String,
    patchId: Schema.String,
  },
) {}

export class KitchenPatchManifest extends Schema.Class<KitchenPatchManifest>(
  "KitchenPatchManifest",
)({
  id: Schema.String,
  issueKey: Schema.optional(Schema.String),
  reason: Schema.optional(Schema.String),
  files: Schema.Array(
    Schema.Struct({
      path: Schema.String,
      content: Schema.String,
    }),
  ),
}) {}

/** Paths must stay under `src/` and remain `.ts` sources. */
export function validatePatchPath(
  path: string,
): Effect.Effect<string, KitchenPatchInvalid> {
  const normalized = path.replace(/\\/g, "/").replace(/^\.\//, "");
  if (
    normalized.startsWith("/") ||
    normalized.includes("..") ||
    normalized.includes("\0")
  ) {
    return Effect.fail(
      new KitchenPatchInvalid({ message: `Invalid patch path: ${path}` }),
    );
  }
  if (!normalized.startsWith("src/")) {
    return Effect.fail(
      new KitchenPatchInvalid({
        message: `Patch paths must be under src/: ${path}`,
      }),
    );
  }
  if (!normalized.endsWith(".ts")) {
    return Effect.fail(
      new KitchenPatchInvalid({
        message: `Only TypeScript sources may be patched: ${path}`,
      }),
    );
  }
  return Effect.succeed(normalized);
}

export function kitchenDir(root: string): string {
  return join(root, ".issue-dinner", "kitchen");
}

export function kitchenApplied(root: string): string {
  return join(kitchenDir(root), "applied");
}

export const MANIFEST_FILE = "manifest.json";
export const CONTRIBUTION_FILE = "contribution.json";

export class KitchenContributionRecord extends Schema.Class<KitchenContributionRecord>(
  "KitchenContributionRecord",
)({
  patchId: Schema.String,
  branch: Schema.String,
  commitSha: Schema.String,
  prUrl: Schema.String,
  contributedAt: Schema.String,
  baseBranch: Schema.String,
  remote: Schema.String,
}) {}
