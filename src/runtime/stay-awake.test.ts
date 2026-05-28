import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  isStayAwakeEnabled,
  stayAwakeInvocationFlags,
  STAY_AWAKE_FLAG,
} from "./stay-awake.js";

describe("isStayAwakeEnabled", () => {
  it("is off by default", () => {
    assert.equal(isStayAwakeEnabled([]), false);
    assert.equal(isStayAwakeEnabled(["serve", "--skip-preflight"]), false);
  });

  it("is on when the flag is present", () => {
    assert.equal(isStayAwakeEnabled([STAY_AWAKE_FLAG]), true);
    assert.equal(isStayAwakeEnabled(["serve", STAY_AWAKE_FLAG]), true);
  });
});

describe("stayAwakeInvocationFlags", () => {
  it("omits flags when disabled", () => {
    assert.deepEqual(stayAwakeInvocationFlags(false), []);
  });

  it("passes --stay-awake when enabled", () => {
    assert.deepEqual(stayAwakeInvocationFlags(true), [STAY_AWAKE_FLAG]);
  });
});
