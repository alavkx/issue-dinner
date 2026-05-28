import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  formatAgentError,
  isSdkCanceledError,
} from "./sdk-errors.js";

describe("isSdkCanceledError", () => {
  it("detects ConnectError canceled code", () => {
    assert.equal(
      isSdkCanceledError({ name: "ConnectError", code: 1, message: "canceled" }),
      true,
    );
  });

  it("detects abort message text", () => {
    assert.equal(
      isSdkCanceledError(new Error("This operation was aborted")),
      true,
    );
  });

  it("returns false for unrelated errors", () => {
    assert.equal(isSdkCanceledError(new Error("ENOENT")), false);
  });
});

describe("formatAgentError", () => {
  it("uses plain English for canceled errors", () => {
    const text = formatAgentError({
      name: "ConnectError",
      code: 1,
      rawMessage: "This operation was aborted",
    });
    assert.match(text, /canceled/i);
  });
});
