import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runVerifyCommands } from "./runner.js";

describe("runVerifyCommands", () => {
  it("returns ok when all commands exit zero", async () => {
    const result = await runVerifyCommands([
      {
        name: "noop",
        command: "node",
        args: ["-e", "process.exit(0)"],
        cwd: process.cwd(),
      },
    ]);
    assert.equal(result.ok, true);
    assert.equal(result.failures.length, 0);
  });

  it("runs each command in its own cwd for multi-root verify", async () => {
    const result = await runVerifyCommands([
      {
        name: "a",
        command: "node",
        args: ["-e", "process.exit(0)"],
        cwd: process.cwd(),
      },
      {
        name: "b",
        command: "node",
        args: ["-e", "process.exit(0)"],
        cwd: process.cwd(),
      },
    ]);
    assert.equal(result.ok, true);
  });

  it("returns failures when a command exits non-zero", async () => {
    const result = await runVerifyCommands([
      {
        name: "fail",
        command: "node",
        args: ["-e", "process.exit(1)"],
        cwd: process.cwd(),
      },
    ]);
    assert.equal(result.ok, false);
    assert.equal(result.failures.length, 1);
    assert.equal(result.failures[0]?.name, "fail");
  });
});
