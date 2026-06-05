import { join } from "node:path";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export class HealPatchInvalid extends Schema.TaggedError<HealPatchInvalid>()(
  "HealPatchInvalid",
  {
    message: Schema.String,
    patchId: Schema.optional(Schema.String),
  },
) {}

export class HealApplyFailed extends Schema.TaggedError<HealApplyFailed>()(
  "HealApplyFailed",
  {
    message: Schema.String,
    patchId: Schema.String,
  },
) {}

export const ISSUE_DINNER_PACKAGE = "issue-dinner";

export class HealPatchManifest extends Schema.Class<HealPatchManifest>(
  "HealPatchManifest",
)({
  id: Schema.String,
  issueKey: Schema.optional(Schema.String),
  reason: Schema.optional(Schema.String),
  /** npm package name the heal targets; omitted on legacy manifests. */
  packageName: Schema.optional(Schema.String),
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
): Effect.Effect<string, HealPatchInvalid> {
  const normalized = path.replace(/\\/g, "/").replace(/^\.\//, "");
  if (
    normalized.startsWith("/") ||
    normalized.includes("..") ||
    normalized.includes("\0")
  ) {
    return Effect.fail(
      new HealPatchInvalid({ message: `Invalid patch path: ${path}` }),
    );
  }
  if (!normalized.startsWith("src/")) {
    return Effect.fail(
      new HealPatchInvalid({
        message: `Patch paths must be under src/: ${path}`,
      }),
    );
  }
  if (!normalized.endsWith(".ts")) {
    return Effect.fail(
      new HealPatchInvalid({
        message: `Only TypeScript sources may be patched: ${path}`,
      }),
    );
  }
  return Effect.succeed(normalized);
}

export function healDir(root: string): string {
  return join(root, ".issue-dinner", "heals");
}

export function healAppliedDir(root: string): string {
  return join(healDir(root), "applied");
}

export const MANIFEST_FILE = "manifest.json";
export const CONTRIBUTION_FILE = "contribution.json";

export class HealContributionRecord extends Schema.Class<HealContributionRecord>(
  "HealContributionRecord",
)({
  patchId: Schema.String,
  branch: Schema.String,
  commitSha: Schema.String,
  prUrl: Schema.String,
  contributedAt: Schema.String,
  baseBranch: Schema.String,
  remote: Schema.String,
}) {}
