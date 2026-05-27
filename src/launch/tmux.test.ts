import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildLaunchShellCommand } from "./tmux.js";

describe("buildLaunchShellCommand", () => {
  it("exports ISSUE_DINNER_CURSOR_API_KEY before serve", () => {
    const cmd = buildLaunchShellCommand(
      "issue-dinner serve",
      "cursor_test_key",
    );
    assert.match(cmd, /export ISSUE_DINNER_CURSOR_API_KEY=cursor_test_key/);
    assert.match(cmd, /issue-dinner serve/);
  });

  it("shell-quotes keys with special characters", () => {
    const cmd = buildLaunchShellCommand("issue-dinner serve", "key'with'quotes");
    assert.match(cmd, /export ISSUE_DINNER_CURSOR_API_KEY=/);
    assert.match(cmd, /key/);
    assert.doesNotMatch(cmd, /export ISSUE_DINNER_CURSOR_API_KEY=key'with'quotes/);
  });

  it("fails fast when the api key is missing", () => {
    const cmd = buildLaunchShellCommand("issue-dinner serve", "");
    assert.match(cmd, /Missing ISSUE_DINNER_CURSOR_API_KEY/);
    assert.doesNotMatch(cmd, /issue-dinner serve/);
  });

  it("keeps shell open after serve", () => {
    const cmd = buildLaunchShellCommand("issue-dinner serve", "cursor_test");
    assert.match(cmd, /exec .* -l/);
    assert.match(cmd, /serve finished/);
  });
});
