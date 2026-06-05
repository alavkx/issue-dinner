import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { filterVerifyCommandsForServe } from "./runner.js";
import type { ResolvedVerifyCommand } from "./resolve.js";

const cmds: ResolvedVerifyCommand[] = [
  {
    name: "unit",
    tier: "inner",
    command: "pytest",
    args: [],
    cwd: "/tmp",
  },
  {
    name: "integration",
    tier: "outer",
    command: "./script.sh",
    args: [],
    cwd: "/tmp",
  },
  {
    name: "legacy",
    command: "echo",
    args: ["ok"],
    cwd: "/tmp",
  },
];

describe("filterVerifyCommandsForServe", () => {
  it("inner gate keeps inner and untagged commands", () => {
    const filtered = filterVerifyCommandsForServe(cmds, "inner");
    assert.deepEqual(
      filtered.map((c) => c.name),
      ["unit", "legacy"],
    );
  });

  it("full gate runs all commands", () => {
    assert.equal(filterVerifyCommandsForServe(cmds, "full").length, 3);
  });

  it("none gate runs nothing", () => {
    assert.equal(filterVerifyCommandsForServe(cmds, "none").length, 0);
  });
});
