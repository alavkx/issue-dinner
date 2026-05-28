import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import * as FileSystem from "@effect/platform/FileSystem";
import * as Effect from "effect/Effect";
import { z } from "zod";
import { ConfigNotFound } from "./effect/errors.js";

const VerifyTierSchema = z.enum(["inner", "outer"]);

const VerifyCommandSchema = z.object({
  name: z.string(),
  command: z.string(),
  args: z.array(z.string()),
  /** Workspace key for cwd when running this command (multi-root verify). */
  workspace: z.string().optional(),
  /**
   * inner — fast gate during serve (unit tests, typecheck).
   * outer — full/integration checks; run via `verify` command or CI, not inner loop.
   */
  tier: VerifyTierSchema.optional(),
});

export type VerifyTier = z.infer<typeof VerifyTierSchema>;
export type ServeVerifyGate = "inner" | "full" | "none";

const SettingSourceSchema = z.enum(["project", "user", "team"]);

/** Install-level settings (workspaces, verify, author). Not per-epic. */
const MachineConfigSchema = z.object({
  model: z.string().default("composer-2.5"),
  workspaces: z.record(z.string()),
  defaultWorkspace: z.string(),
  issueWorkspace: z.record(z.string()).optional(),
  /** Multiple workspace keys → SDK `local.cwd: string[]` for one agent. */
  issueWorkspaces: z.record(z.array(z.string())).optional(),
  settingSources: z.array(SettingSourceSchema).default(["project"]),
  requireVerify: z.boolean().default(true),
  /**
   * Which verify command tiers block serve progression.
   * inner — only `tier: inner` (or untagged) commands; outer/CI checks deferred.
   * full — all configured verify commands (slow integration included).
   * none — same as --skip-verify during serve.
   */
  serveVerifyGate: z.enum(["inner", "full", "none"]).default("inner"),
  requireHandoffTests: z.boolean().default(true),
  verifyCommands: z.record(z.array(VerifyCommandSchema)).optional(),
  issueVerifyCommands: z.record(z.array(VerifyCommandSchema)).optional(),
  /** Git branch namespace, e.g. alavoie → alavoie/cpd-635/cpd-636 */
  stackAuthor: z.string().optional(),
  /** Override epic trunk branch if you already use a non-default name. */
  stackBaseOverride: z.string().optional(),
  graphiteTrunk: z.string().default("main"),
  /** When agent_complete counts as done for Jira blocker gating. */
  blockerPolicy: z.enum(["strict", "agent_complete"]).default("strict"),
  /** Commit WIP in each workspace after successful agent phase. */
  commitWip: z.boolean().default(true),
  /** SDK recovery passes per failure (stack/verify/handoff) before giving up. */
  recoveryAttempts: z.number().int().min(0).max(5).default(2),
  /**
   * Recovery agents write to transcript only (no stdout stream).
   * Set false for full recovery stream in the terminal.
   */
  quietRecovery: z.boolean().default(true),
});

export type MachineConfig = z.infer<typeof MachineConfigSchema>;

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

export function loadMachineConfigSync(explicit?: string): MachineConfig {
  const path = findConfigPath(explicit);
  if (!path) {
    throw new Error(
      "No install config found. Create ~/.config/issue-dinner/config.json (see config.example.json).",
    );
  }
  const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
  return MachineConfigSchema.parse(raw);
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
    try {
      return MachineConfigSchema.parse(JSON.parse(raw) as unknown);
    } catch {
      return yield* Effect.fail(
        new ConfigNotFound({ message: `Invalid config at ${path}` }),
      );
    }
  });

/** @deprecated Use loadMachineConfig Effect program. */
export const loadConfig = loadMachineConfigSync;

export {
  formatWorkspacesLabel,
  localAgentOptions,
  resolveCwd,
  resolveIssueWorkspaces,
  resolveWorkspaceKey,
  sdkCwd,
} from "./config/workspaces.js";
export type { IssueWorkspaces } from "./config/workspaces.js";
