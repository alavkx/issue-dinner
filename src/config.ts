import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";

const VerifyCommandSchema = z.object({
  name: z.string(),
  command: z.string(),
  args: z.array(z.string()),
  /** Workspace key for cwd when running this command (multi-root verify). */
  workspace: z.string().optional(),
});

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
  requireHandoffTests: z.boolean().default(true),
  verifyCommands: z.record(z.array(VerifyCommandSchema)).optional(),
  issueVerifyCommands: z.record(z.array(VerifyCommandSchema)).optional(),
  /** Git branch namespace, e.g. alavoie → alavoie/cpd-635/cpd-636 */
  stackAuthor: z.string().optional(),
  /** Override epic trunk branch if you already use a non-default name. */
  stackBaseOverride: z.string().optional(),
  graphiteTrunk: z.string().default("main"),
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

export function loadMachineConfig(explicit?: string): MachineConfig {
  const path = findConfigPath(explicit);
  if (!path) {
    throw new Error(
      "No install config found. Create ~/.config/issue-dinner/config.json (see config.example.json).",
    );
  }
  const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
  return MachineConfigSchema.parse(raw);
}

/** @deprecated Use loadMachineConfig */
export const loadConfig = loadMachineConfig;

export {
  formatWorkspacesLabel,
  localAgentOptions,
  resolveCwd,
  resolveIssueWorkspaces,
  resolveWorkspaceKey,
  sdkCwd,
} from "./config/workspaces.js";
export type { IssueWorkspaces } from "./config/workspaces.js";
