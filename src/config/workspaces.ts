import { resolve } from "node:path";
import type { MachineConfig } from "../config.js";

export interface IssueWorkspaces {
  primaryKey: string;
  keys: string[];
  cwds: string[];
}

export function resolveWorkspaceKey(
  config: MachineConfig,
  issueKey: string,
  description: string,
  summary: string,
): string {
  if (config.issueWorkspace?.[issueKey]) {
    return config.issueWorkspace[issueKey];
  }
  const text = `${summary}\n${description}`.toLowerCase();
  if (
    "frontend" in config.workspaces &&
    (text.includes("frontend") ||
      text.includes("react") ||
      text.includes("tanstack"))
  ) {
    return "frontend";
  }
  if (
    "schemas" in config.workspaces &&
    (text.includes("openapi") ||
      text.includes("api-schemas"))
  ) {
    return "schemas";
  }
  return config.defaultWorkspace;
}

export function resolveCwd(config: MachineConfig, workspaceKey: string): string {
  const cwd = config.workspaces[workspaceKey];
  if (!cwd) {
    throw new Error(
      `Unknown workspace "${workspaceKey}". Known: ${Object.keys(config.workspaces).join(", ")}`,
    );
  }
  return resolve(cwd);
}

export function resolveIssueWorkspaces(
  config: MachineConfig,
  issueKey: string,
  description: string,
  summary: string,
): IssueWorkspaces {
  let keys: string[];
  const configured = config.issueWorkspaces?.[issueKey];
  if (configured && configured.length > 0) {
    keys = [...configured];
  } else {
    keys = [resolveWorkspaceKey(config, issueKey, description, summary)];
  }

  keys = [...new Set(keys)];
  for (const key of keys) {
    if (!(key in config.workspaces)) {
      throw new Error(
        `Unknown workspace "${key}" for ${issueKey}. Known: ${Object.keys(config.workspaces).join(", ")}`,
      );
    }
  }

  const cwds = keys.map((k) => resolveCwd(config, k));
  return { primaryKey: keys[0]!, keys, cwds };
}

export function sdkCwd(cwds: string[]): string | string[] {
  if (cwds.length === 1) return cwds[0]!;
  return cwds;
}

export function localAgentOptions(
  config: MachineConfig,
  cwds: string[],
): {
  cwd: string | string[];
  settingSources: Array<"project" | "user" | "team">;
} {
  return {
    cwd: sdkCwd(cwds),
    settingSources: [...config.settingSources],
  };
}

/** Story agent workspace roots — includes issue-dinner root when self-heal is on. */
export function storyAgentOptions(
  config: MachineConfig,
  roots: IssueWorkspaces,
  toolRoot?: string,
): {
  cwd: string | string[];
  settingSources: Array<"project" | "user" | "team">;
} {
  if (!toolRoot) {
    return localAgentOptions(config, roots.cwds);
  }
  const combined =
    roots.cwds.length === 1
      ? [toolRoot, roots.cwds[0]!]
      : [toolRoot, ...roots.cwds];
  return {
    cwd: sdkCwd(combined),
    settingSources: [...config.settingSources],
  };
}

/** Dedicated heal agent — issue-dinner package root only. */
export function healAgentOptions(
  config: MachineConfig,
  toolRoot: string,
): {
  cwd: string;
  settingSources: Array<"project" | "user" | "team">;
} {
  return {
    cwd: toolRoot,
    settingSources: [...config.settingSources],
  };
}

export function formatWorkspacesLabel(roots: IssueWorkspaces): string {
  if (roots.keys.length === 1) {
    return `${roots.keys[0]} (${roots.cwds[0]})`;
  }
  return roots.keys.map((key, i) => `${key}=${roots.cwds[i]}`).join(", ");
}
