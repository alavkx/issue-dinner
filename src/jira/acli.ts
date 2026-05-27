import { runCommand } from "../util/exec.js";
import { adfToMarkdown, descriptionToText } from "./adf.js";
import { parseIssueDescription, type ParsedIssueBody } from "./parse-issue.js";

export interface JiraIssue {
  key: string;
  summary: string;
  status: string;
  description: string;
  parsed: ParsedIssueBody;
}

interface AcliIssueJson {
  key: string;
  fields: {
    summary?: string;
    status?: { name?: string };
    description?: unknown;
  };
}

function parseIssueJson(data: AcliIssueJson): JiraIssue {
  const description = descriptionToText(data.fields.description);
  return {
    key: data.key,
    summary: data.fields.summary ?? "",
    status: data.fields.status?.name ?? "Unknown",
    description,
    parsed: parseIssueDescription(description),
  };
}

export async function fetchIssue(key: string): Promise<JiraIssue> {
  const { stdout } = await runCommand("acli", [
    "jira",
    "workitem",
    "view",
    key,
    "--fields",
    "summary,description,status",
    "--json",
  ]);
  return parseIssueJson(JSON.parse(stdout) as AcliIssueJson);
}

export async function listEpicChildren(epicKey: string): Promise<JiraIssue[]> {
  const jql = `parent = ${epicKey} ORDER BY key`;
  const { stdout } = await runCommand("acli", [
    "jira",
    "workitem",
    "search",
    "--jql",
    jql,
    "--fields",
    "key,summary,status",
    "--json",
  ]);

  const payload = JSON.parse(stdout) as Array<{ key: string }>;

  const issues: JiraIssue[] = [];
  for (const row of payload) {
    issues.push(await fetchIssue(row.key));
  }
  return issues;
}

export async function ensureAcli(): Promise<void> {
  try {
    await runCommand("acli", ["jira", "auth", "status"]);
  } catch {
    throw new Error(
      "acli is not installed or not authenticated. Run: acli jira auth login --web",
    );
  }
}

/** Plain-text description via CLI table output (fallback). */
export async function fetchIssuePlain(key: string): Promise<string> {
  const { stdout } = await runCommand("acli", [
    "jira",
    "workitem",
    "view",
    key,
    "--fields",
    "description",
  ]);
  const marker = "Description:";
  const idx = stdout.indexOf(marker);
  if (idx === -1) return stdout.trim();
  return stdout.slice(idx + marker.length).trim();
}

export { adfToMarkdown };
