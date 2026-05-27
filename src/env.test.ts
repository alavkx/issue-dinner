import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { cursorApiKey, cursorApiKeyEnvName } from "./env.js";

describe("cursorApiKey", () => {
  it("reads ISSUE_DINNER_CURSOR_API_KEY", () => {
    const prev = process.env.ISSUE_DINNER_CURSOR_API_KEY;
    process.env.ISSUE_DINNER_CURSOR_API_KEY = "cursor_test";
    try {
      assert.equal(cursorApiKey(), "cursor_test");
      assert.equal(cursorApiKeyEnvName(), "ISSUE_DINNER_CURSOR_API_KEY");
    } finally {
      if (prev === undefined) delete process.env.ISSUE_DINNER_CURSOR_API_KEY;
      else process.env.ISSUE_DINNER_CURSOR_API_KEY = prev;
    }
  });

  it("throws when unset", () => {
    const prev = process.env.ISSUE_DINNER_CURSOR_API_KEY;
    delete process.env.ISSUE_DINNER_CURSOR_API_KEY;
    try {
      assert.throws(() => cursorApiKey(), /ISSUE_DINNER_CURSOR_API_KEY/);
    } finally {
      if (prev !== undefined) process.env.ISSUE_DINNER_CURSOR_API_KEY = prev;
    }
  });
});
