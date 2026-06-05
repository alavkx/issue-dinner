import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveStackForEpic } from "./stack.js";

describe("resolveStackForEpic", () => {
  it("derives prefix and trunk base from the epic key and stack author", () => {
    const stack = resolveStackForEpic("PROJ-100", { stackAuthor: "dev" });
    assert.equal(stack.prefix, "dev/proj-100");
    assert.equal(stack.base, "dev/proj-100-trunk");
    assert.equal(stack.graphiteTrunk, "main");
  });

  it("reads stack author from ISSUE_DINNER_STACK_AUTHOR when not in config", () => {
    const prev = process.env.ISSUE_DINNER_STACK_AUTHOR;
    process.env.ISSUE_DINNER_STACK_AUTHOR = "jdilla";
    try {
      const stack = resolveStackForEpic("CPD-100", {});
      assert.equal(stack.prefix, "jdilla/cpd-100");
    } finally {
      if (prev === undefined) delete process.env.ISSUE_DINNER_STACK_AUTHOR;
      else process.env.ISSUE_DINNER_STACK_AUTHOR = prev;
    }
  });

  it("allows a one-off base override on the machine config", () => {
    const stack = resolveStackForEpic("PROJ-100", {
      stackAuthor: "dev",
      stackBaseOverride: "dev/proj-100-custom",
    });
    assert.equal(stack.base, "dev/proj-100-custom");
  });
});
