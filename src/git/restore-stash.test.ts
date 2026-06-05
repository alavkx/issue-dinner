import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { autoStashMessage } from "./restore-stash.js";

describe("autoStashMessage", () => {
  it("embeds issue key for round-trip restore", () => {
    assert.equal(autoStashMessage("CPD-639"), "issue-dinner auto-stash CPD-639");
  });
});
