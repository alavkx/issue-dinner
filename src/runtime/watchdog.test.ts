import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { stripWatchArgv, WATCH_FLAG } from "./watchdog.js";
import { SELF_HEAL_FLAG } from "./self-heal-flags.js";

describe("stripWatchArgv", () => {
  it("removes watch flags and preserves meal argv", () => {
    const stripped = stripWatchArgv([
      "CPD-635",
      "serve",
      WATCH_FLAG,
      SELF_HEAL_FLAG,
      "--skip-preflight",
    ]);
    assert.equal(stripped.watch, true);
    assert.equal(stripped.restartOnCrash, true);
    assert.deepEqual(stripped.argv, [
      "CPD-635",
      "serve",
      SELF_HEAL_FLAG,
      "--skip-preflight",
    ]);
  });
});
