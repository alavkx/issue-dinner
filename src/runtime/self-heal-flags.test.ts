import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  isSelfHealEnabled,
  NO_SELF_HEAL_FLAG,
  selfHealInvocationFlags,
  SELF_HEAL_FLAG,
} from "./self-heal-flags.js";

describe("isSelfHealEnabled", () => {
  it("is enabled by default", () => {
    assert.equal(isSelfHealEnabled([]), true);
    assert.equal(isSelfHealEnabled(["serve", "--skip-preflight"]), true);
  });

  it("can be disabled explicitly", () => {
    assert.equal(isSelfHealEnabled([NO_SELF_HEAL_FLAG]), false);
    assert.equal(isSelfHealEnabled(["serve", NO_SELF_HEAL_FLAG]), false);
  });

  it("honors redundant --self-heal when not disabled", () => {
    assert.equal(isSelfHealEnabled([SELF_HEAL_FLAG]), true);
  });
});

describe("selfHealInvocationFlags", () => {
  it("omits flags when enabled (default)", () => {
    assert.deepEqual(selfHealInvocationFlags(true), []);
  });

  it("passes --no-self-heal when disabled", () => {
    assert.deepEqual(selfHealInvocationFlags(false), [NO_SELF_HEAL_FLAG]);
  });
});
