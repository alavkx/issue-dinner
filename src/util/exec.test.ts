import assert from "node:assert/strict";
import * as Effect from "effect/Effect";
import { describe, it } from "node:test";
import { runEffect } from "../effect/test-runtime.js";
import { CommandFailed, commandExists, runCommand } from "./exec.js";

describe("runCommand", () => {
  it("returns stdout and stderr for a successful command", () =>
    runEffect(
      Effect.gen(function* () {
        const result = yield* runCommand("echo", ["-n", "hello"]);
        assert.equal(result.stdout, "hello");
        assert.equal(result.stderr, "");
      }),
    ));

  it("fails with CommandFailed when exit code is non-zero", () =>
    runEffect(
      Effect.gen(function* () {
        const result = yield* Effect.either(
          runCommand("sh", ["-c", "echo err >&2; exit 2"]),
        );
        assert.equal(result._tag, "Left");
        if (result._tag === "Left") {
          assert.ok(result.left instanceof CommandFailed);
          assert.equal(result.left.code, 2);
          assert.match(result.left.stderr, /err/);
        }
      }),
    ));
});

describe("commandExists", () => {
  it("returns true for a command on PATH", () =>
    runEffect(
      Effect.gen(function* () {
        assert.equal(yield* commandExists("echo"), true);
      }),
    ));

  it("returns false for a missing command", () =>
    runEffect(
      Effect.gen(function* () {
        assert.equal(
          yield* commandExists("issue-dinner-nonexistent-cmd-xyz"),
          false,
        );
      }),
    ));
});

describe("shellQuote", () => {
  it("leaves simple args unquoted", async () => {
    const { shellQuote } = await import("./exec.js");
    assert.equal(shellQuote("CPD-635"), "CPD-635");
  });
});
