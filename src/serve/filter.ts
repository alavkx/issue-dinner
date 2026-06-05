import type { JiraIssue } from "../jira/acli.js";

export interface StoryFilterOptions {
  exclude?: Set<string>;
  only?: Set<string>;
}

export function filterEpicStories(
  issues: JiraIssue[],
  opts: StoryFilterOptions,
): JiraIssue[] {
  return issues.filter((issue) => {
    if (opts.exclude?.has(issue.key)) return false;
    if (opts.only && !opts.only.has(issue.key)) return false;
    return true;
  });
}

export function parseKeyList(csv: string | undefined): Set<string> | undefined {
  if (!csv?.trim()) return undefined;
  return new Set(
    csv
      .split(",")
      .map((k) => k.trim())
      .filter(Boolean),
  );
}
