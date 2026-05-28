import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildServeInvocation } from "./serve-invocation.js";
import { isSelfHealEnabled, NO_SELF_HEAL_FLAG } from "../runtime/self-heal-flags.js";

describe("serve self-heal defaults", () => {
  it("does not pass self-heal flags when enabled by default", () => {
    const cmd = buildServeInvocation("/usr/local/bin/issue-dinner", "CPD-635", undefined, {
      selfHeal: true,
    });
    assert.doesNotMatch(cmd, /--self-heal/);
    assert.doesNotMatch(cmd, /--no-self-heal/);
  });

  it("passes --no-self-heal when disabled", () => {
    const cmd = buildServeInvocation("/usr/local/bin/issue-dinner", "CPD-635", undefined, {
      selfHeal: false,
    });
    assert.match(cmd, /--no-self-heal/);
  });

  it("treats serve args as self-heal on unless opted out", () => {
    assert.equal(isSelfHealEnabled(["serve", "--skip-preflight"]), true);
    assert.equal(isSelfHealEnabled(["serve", NO_SELF_HEAL_FLAG]), false);
  });

  it("forwards --stay-awake into tmux serve invocations", () => {
    const cmd = buildServeInvocation("/usr/local/bin/issue-dinner", "CPD-635", undefined, {
      stayAwake: true,
    });
    assert.match(cmd, /--stay-awake/);
  });

  it("does not forward stay-awake when disabled", () => {
    const cmd = buildServeInvocation("/usr/local/bin/issue-dinner", "CPD-635", undefined, {
      stayAwake: false,
    });
    assert.doesNotMatch(cmd, /--stay-awake/);
  });
});
