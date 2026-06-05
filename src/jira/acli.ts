import type * as CommandExecutor from "@effect/platform/CommandExecutor";
import * as Effect from "effect/Effect";
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

export const fetchIssue = (
  key: string,
): Effect.Effect<
  JiraIssue,
  import("@effect/platform/Error").PlatformError | import("../effect/errors.js").CommandFailed,
  CommandExecutor.CommandExecutor
> =>
  runCommand("acli", [
    "jira",
    "workitem",
    "view",
    key,
    "--fields",
    "summary,description,status",
    "--json",
  ]).pipe(
    Effect.map(({ stdout }) =>
      parseIssueJson(JSON.parse(stdout) as AcliIssueJson),
    ),
  );

export const listEpicChildren = (
  epicKey: string,
): Effect.Effect<
  JiraIssue[],
  import("@effect/platform/Error").PlatformError | import("../effect/errors.js").CommandFailed,
  CommandExecutor.CommandExecutor
> =>
  Effect.gen(function* () {
    const jql = `parent = ${epicKey} ORDER BY key`;
    const { stdout } = yield* runCommand("acli", [
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
      issues.push(yield* fetchIssue(row.key));
    }
    return issues;
  });

export const ensureAcli = Effect.gen(function* () {
  yield* runCommand("acli", ["jira", "auth", "status"]).pipe(
    Effect.catchAll(() =>
      Effect.fail(
        new Error(
          "acli is not installed or not authenticated. Run: acli jira auth login --web",
        ),
      ),
    ),
  );
});

/** Plain-text description via CLI table output (fallback). */
export const fetchIssuePlain = (
  key: string,
): Effect.Effect<
  string,
  import("@effect/platform/Error").PlatformError | import("../effect/errors.js").CommandFailed,
  CommandExecutor.CommandExecutor
> =>
  runCommand("acli", [
    "jira",
    "workitem",
    "view",
    key,
    "--fields",
    "description",
  ]).pipe(
    Effect.map(({ stdout }) => {
      const marker = "Description:";
      const idx = stdout.indexOf(marker);
      if (idx === -1) return stdout.trim();
      return stdout.slice(idx + marker.length).trim();
    }),
  );

export { adfToMarkdown };
