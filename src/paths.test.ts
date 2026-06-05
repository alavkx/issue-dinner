import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  defaultStateDir,
  resolveStateDir,
  stateDirForEpic,
} from "./paths.js";

describe("resolveStateDir", () => {
  it("defaults to XDG-style path under home", () => {
    assert.equal(resolveStateDir(), defaultStateDir());
    assert.match(defaultStateDir(), /issue-dinner$/);
  });

  it("scopes state under the epic key", () => {
    assert.match(stateDirForEpic("CPD-635"), /issue-dinner\/CPD-635$/);
  });

  it("honors ISSUE_DINNER_STATE_DIR", () => {
    const prev = process.env.ISSUE_DINNER_STATE_DIR;
    process.env.ISSUE_DINNER_STATE_DIR = "/tmp/issue-dinner-test-state";
    try {
      assert.equal(resolveStateDir(), "/tmp/issue-dinner-test-state");
    } finally {
      if (prev === undefined) delete process.env.ISSUE_DINNER_STATE_DIR;
      else process.env.ISSUE_DINNER_STATE_DIR = prev;
    }
  });
});
