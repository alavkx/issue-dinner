import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { validatePatchPath } from "./patch.js";
import { runEffect } from "../effect/test-runtime.js";

describe("validatePatchPath", () => {
  it("accepts src typescript paths", async () => {
    const path = await runEffect(validatePatchPath("src/agent/recovery.ts"));
    assert.equal(path, "src/agent/recovery.ts");
  });

  it("rejects traversal and non-src paths", async () => {
    await assert.rejects(() => runEffect(validatePatchPath("../secrets.ts")));
    await assert.rejects(() => runEffect(validatePatchPath("package.json")));
    await assert.rejects(() => runEffect(validatePatchPath("src/agent/recovery.js")));
  });
});
