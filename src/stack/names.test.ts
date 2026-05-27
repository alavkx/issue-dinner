import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { storyBranchName } from "./names.js";

describe("storyBranchName", () => {
  it("places the issue key under the stack prefix", () => {
    assert.equal(
      storyBranchName("alavoie/cpd-635", "CPD-636"),
      "alavoie/cpd-635/cpd-636",
    );
  });
});
