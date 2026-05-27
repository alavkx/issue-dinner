import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { JiraIssue } from "../jira/acli.js";
import { filterMenuIssues } from "./filter.js";

function issue(key: string): JiraIssue {
  return {
    key,
    summary: key,
    status: "Open",
    description: "",
    parsed: { acceptanceCriteria: [], blockedBy: [] },
  };
}

describe("filterMenuIssues", () => {
  it("excludes keys in the exclude set", () => {
    const menu = filterMenuIssues([issue("CPD-636"), issue("CPD-640")], {
      exclude: new Set(["CPD-640"]),
    });
    assert.deepEqual(
      menu.map((i) => i.key),
      ["CPD-636"],
    );
  });

  it("applies only allow-list when provided", () => {
    const menu = filterMenuIssues(
      [issue("CPD-636"), issue("CPD-637")],
      { only: new Set(["CPD-637"]) },
    );
    assert.deepEqual(menu.map((i) => i.key), ["CPD-637"]);
  });
});
