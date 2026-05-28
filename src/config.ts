import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import * as FileSystem from "@effect/platform/FileSystem";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { ConfigNotFound } from "./effect/errors.js";

const VerifyTierSchema = Schema.Literal("inner", "outer");
export type VerifyTier = typeof VerifyTierSchema.Type;

const VerifyCommandSchema = Schema.Struct({
  name: Schema.String,
  command: Schema.String,
  args: Schema.Array(Schema.String),
  workspace: Schema.optional(Schema.String),
  tier: Schema.optional(VerifyTierSchema),
});

export type ServeVerifyGate = "inner" | "full" | "none";

const SettingSourceSchema = Schema.Literal("project", "user", "team");

export const MachineConfigSchema = Schema.Struct({
  model: Schema.optionalWith(Schema.String, { default: () => "composer-2.5" }),
  workspaces: Schema.Record({ key: Schema.String, value: Schema.String }),
  defaultWorkspace: Schema.String,
  issueWorkspace: Schema.optional(
    Schema.Record({ key: Schema.String, value: Schema.String }),
  ),
  issueWorkspaces: Schema.optional(
    Schema.Record({ key: Schema.String, value: Schema.Array(Schema.String) }),
  ),
  settingSources: Schema.optionalWith(Schema.Array(SettingSourceSchema), {
    default: () => ["project"] as const,
  }),
  requireVerify: Schema.optionalWith(Schema.Boolean, { default: () => true }),
  serveVerifyGate: Schema.optionalWith(
    Schema.Literal("inner", "full", "none"),
    { default: () => "inner" as const },
  ),
  requireHandoffTests: Schema.optionalWith(Schema.Boolean, {
    default: () => true,
  }),
  verifyCommands: Schema.optional(
    Schema.Record({ key: Schema.String, value: Schema.Array(VerifyCommandSchema) }),
  ),
  issueVerifyCommands: Schema.optional(
    Schema.Record({ key: Schema.String, value: Schema.Array(VerifyCommandSchema) }),
  ),
  stackAuthor: Schema.optional(Schema.String),
  stackBaseOverride: Schema.optional(Schema.String),
  graphiteTrunk: Schema.optionalWith(Schema.String, { default: () => "main" }),
  blockerPolicy: Schema.optionalWith(
    Schema.Literal("strict", "agent_complete"),
    { default: () => "strict" as const },
  ),
  commitWip: Schema.optionalWith(Schema.Boolean, { default: () => true }),
  recoveryAttempts: Schema.optionalWith(
    Schema.Number.pipe(
      Schema.int(),
      Schema.greaterThanOrEqualTo(0),
      Schema.lessThanOrEqualTo(5),
    ),
    { default: () => 2 },
  ),
  quietRecovery: Schema.optionalWith(Schema.Boolean, { default: () => true }),
});

export type MachineConfig = typeof MachineConfigSchema.Type;

/** @deprecated Use MachineConfig */
export type DinnerConfig = MachineConfig;

const CONFIG_NAMES = [
  join(homedir(), ".config", "issue-dinner", "config.json"),
  "issue-dinner.config.json",
];

export function findConfigPath(explicit?: string): string | undefined {
  if (explicit) return resolve(explicit);
  for (const name of CONFIG_NAMES) {
    if (existsSync(name)) return resolve(name);
  }
  const example = resolve("config.example.json");
  if (existsSync(example)) return example;
  return undefined;
}

export const loadMachineConfig = (
  explicit?: string,
): Effect.Effect<MachineConfig, ConfigNotFound, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const path = findConfigPath(explicit);
    if (!path) {
      return yield* Effect.fail(
        new ConfigNotFound({
          message:
            "No install config found. Create ~/.config/issue-dinner/config.json (see config.example.json).",
        }),
      );
    }
    const fs = yield* FileSystem.FileSystem;
    const raw = yield* fs.readFileString(path).pipe(
      Effect.catchAll(() =>
        Effect.fail(
          new ConfigNotFound({ message: `Could not read config at ${path}` }),
        ),
      ),
    );
    const parsed = yield* Schema.decodeUnknown(MachineConfigSchema)(
      JSON.parse(raw) as unknown,
    ).pipe(
      Effect.mapError(
        () =>
          new ConfigNotFound({ message: `Invalid config at ${path}` }),
      ),
    );
    return parsed;
  });

export {
  formatWorkspacesLabel,
  localAgentOptions,
  resolveCwd,
  resolveIssueWorkspaces,
  resolveWorkspaceKey,
  sdkCwd,
} from "./config/workspaces.js";
export type { IssueWorkspaces } from "./config/workspaces.js";
