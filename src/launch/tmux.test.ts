import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildLaunchShellCommand } from "./tmux.js";

describe("buildLaunchShellCommand", () => {
  it("requires ISSUE_DINNER_CURSOR_API_KEY before serve", () => {
    const cmd = buildLaunchShellCommand("issue-dinner serve");
    assert.match(cmd, /ISSUE_DINNER_CURSOR_API_KEY/);
    assert.match(cmd, /issue-dinner serve/);
  });
});
