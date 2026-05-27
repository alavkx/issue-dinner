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

const ConfigSchema = z.object({
  epic: z.string().optional(),
  model: z.string().default("composer-2.5"),
  workspaces: z.record(z.string()),
  defaultWorkspace: z.string(),
  issueWorkspace: z.record(z.string()).optional(),
  /** Multiple workspace keys → SDK `local.cwd: string[]` for one agent. */
  issueWorkspaces: z.record(z.array(z.string())).optional(),
  settingSources: z.array(SettingSourceSchema).default(["project"]),
  requireVerify: z.boolean().default(true),
  requireHandoffTests: z.boolean().default(true),
  exclude: z.array(z.string()).default(["CPD-640"]),
  verifyCommands: z.record(z.array(VerifyCommandSchema)).optional(),
  issueVerifyCommands: z.record(z.array(VerifyCommandSchema)).optional(),
});

export type DinnerConfig = z.infer<typeof ConfigSchema>;

const CONFIG_NAMES = [
  "issue-dinner.config.json",
  join(homedir(), ".config", "issue-dinner", "config.json"),
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

export function loadConfig(explicit?: string): DinnerConfig {
  const path = findConfigPath(explicit);
  if (!path) {
    throw new Error(
      "No config found. Copy config.example.json to issue-dinner.config.json and edit workspaces.",
    );
  }
  const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
  return ConfigSchema.parse(raw);
}

export {
  formatWorkspacesLabel,
  localAgentOptions,
  resolveCwd,
  resolveIssueWorkspaces,
  resolveWorkspaceKey,
  sdkCwd,
} from "./config/workspaces.js";
export type { IssueWorkspaces } from "./config/workspaces.js";
