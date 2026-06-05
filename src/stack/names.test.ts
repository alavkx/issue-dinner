import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { storyBranchName } from "./names.js";

describe("storyBranchName", () => {
  it("places the issue key under the stack prefix", () => {
    assert.equal(
      storyBranchName("dev/proj-100", "PROJ-101"),
      "dev/proj-100/proj-101",
    );
  });
});
