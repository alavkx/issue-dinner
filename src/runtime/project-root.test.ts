import assert from "node:assert/strict";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { moduleIssueDinnerRoot, PACKAGE_NAME_MARKER } from "./project-root.js";

describe("moduleIssueDinnerRoot", () => {
  it("resolves the package root from this module location", () => {
    const expected = resolve(
      join(dirname(fileURLToPath(import.meta.url)), "../.."),
    );
    assert.equal(moduleIssueDinnerRoot(), expected);
  });

  it("matches the issue-dinner package marker", () => {
    assert.match(PACKAGE_NAME_MARKER, /issue-dinner/);
  });
});
