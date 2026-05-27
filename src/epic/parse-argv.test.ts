import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isEpicKey, parseTopLevelArgv } from "./parse-argv.js";

describe("parseTopLevelArgv", () => {
  it("detects an epic-first invocation", () => {
    const parsed = parseTopLevelArgv(["CPD-635", "list"]);
    assert.equal(parsed.mode, "meal");
    assert.equal(parsed.epic, "CPD-635");
    assert.deepEqual(parsed.rest, ["list"]);
  });

  it("defaults meal commands to launch", () => {
    const parsed = parseTopLevelArgv(["CPD-635"]);
    assert.equal(parsed.mode, "meal");
    assert.deepEqual(parsed.rest, ["launch"]);
  });

  it("defaults to launch when flags precede a subcommand", () => {
    const parsed = parseTopLevelArgv([
      "CPD-635",
      "--exclude",
      "CPD-640",
    ]);
    assert.equal(parsed.mode, "meal");
    assert.deepEqual(parsed.rest, ["launch", "--exclude", "CPD-640"]);
  });

  it("routes global utilities without an epic", () => {
    const parsed = parseTopLevelArgv(["show", "CPD-636"]);
    assert.equal(parsed.mode, "global");
    assert.deepEqual(parsed.rest, ["show", "CPD-636"]);
  });
});

describe("isEpicKey", () => {
  it("accepts project-issue keys", () => {
    assert.equal(isEpicKey("CPD-635"), true);
    assert.equal(isEpicKey("list"), false);
  });
});
