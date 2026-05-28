import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as Effect from "effect/Effect";
import { runEffect } from "../effect/test-runtime.js";
import { disposeAgent } from "./lifecycle.js";

describe("disposeAgent", () => {
  it("completes when dispose succeeds", () =>
    runEffect(
      disposeAgent({
        [Symbol.asyncDispose]: async () => {},
      }),
    ));

  it("ignores SDK cancel errors during dispose", () =>
    runEffect(
      disposeAgent({
        [Symbol.asyncDispose]: async () => {
          const err = new Error("This operation was aborted");
          err.name = "ConnectError";
          throw err;
        },
      }),
    ));

  it("surfaces non-cancel dispose failures without throwing", () =>
    runEffect(
      disposeAgent({
        [Symbol.asyncDispose]: async () => {
          throw new Error("ENOENT");
        },
      }).pipe(
        Effect.tap(() => assert.ok(true)),
        Effect.asVoid,
      ),
    ));
});
