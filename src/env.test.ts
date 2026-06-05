import assert from "node:assert/strict";
import * as Effect from "effect/Effect";
import { describe, it } from "node:test";
import { runEffect } from "./effect/test-runtime.js";
import { cursorApiKey, cursorApiKeyEnvName } from "./env.js";

describe("cursorApiKey", () => {
  it("reads ISSUE_DINNER_CURSOR_API_KEY", () =>
    runEffect(
      Effect.gen(function* () {
        const prev = process.env.ISSUE_DINNER_CURSOR_API_KEY;
        process.env.ISSUE_DINNER_CURSOR_API_KEY = "cursor_test";
        try {
          assert.equal(yield* cursorApiKey, "cursor_test");
          assert.equal(cursorApiKeyEnvName(), "ISSUE_DINNER_CURSOR_API_KEY");
        } finally {
          if (prev === undefined) delete process.env.ISSUE_DINNER_CURSOR_API_KEY;
          else process.env.ISSUE_DINNER_CURSOR_API_KEY = prev;
        }
      }),
    ));

  it("fails when unset", () =>
    runEffect(
      Effect.gen(function* () {
        const prev = process.env.ISSUE_DINNER_CURSOR_API_KEY;
        delete process.env.ISSUE_DINNER_CURSOR_API_KEY;
        try {
          const result = yield* Effect.either(cursorApiKey);
          assert.equal(result._tag, "Left");
          if (result._tag === "Left") {
            assert.match(result.left.message, /ISSUE_DINNER_CURSOR_API_KEY/);
          }
        } finally {
          if (prev !== undefined) process.env.ISSUE_DINNER_CURSOR_API_KEY = prev;
        }
      }),
    ));
});
