import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it } from "node:test";
import * as Effect from "effect/Effect";
import { runEffect } from "../effect/test-runtime.js";
import {
  inferInnerVerifyCommands,
  unitTestPathsBesideIntegration,
} from "./infer.js";
import type { ResolvedVerifyCommand } from "./resolve.js";

describe("unitTestPathsBesideIntegration", () => {
  it("finds unit tests beside an integration routes file", () => {
    const cwd = mkdtempSync(join(tmpdir(), "issue-dinner-infer-"));
    const unitDir = join(cwd, "tests/v3/unit_test");
    mkdirSync(unitDir, { recursive: true });
    writeFileSync(join(unitDir, "test_notification_service.py"), "");
    writeFileSync(join(unitDir, "test_notification_task.py"), "");

    return runEffect(
      unitTestPathsBesideIntegration(
        cwd,
        "tests/v3/integration/test_notification_routes.py",
      ).pipe(
        Effect.tap((paths) => {
          assert.equal(paths.length, 2);
          assert.ok(paths.every((p) => p.includes("unit_test")));
        }),
        Effect.asVoid,
      ),
    );
  });
});

describe("inferInnerVerifyCommands", () => {
  it("builds inner pytest from outer integration command", () => {
    const cwd = mkdtempSync(join(tmpdir(), "issue-dinner-infer-"));
    const unitDir = join(cwd, "tests/v3/unit_test");
    const intDir = join(cwd, "tests/v3/integration");
    mkdirSync(unitDir, { recursive: true });
    mkdirSync(intDir, { recursive: true });
    writeFileSync(join(unitDir, "test_notification_service.py"), "");
    writeFileSync(join(intDir, "test_notification_routes.py"), "");

    const outer: ResolvedVerifyCommand = {
      name: "notifications-integration",
      tier: "outer",
      command: "poetry",
      args: [
        "run",
        "pytest",
        "tests/v3/integration/test_notification_routes.py",
        "-q",
        "--tb=short",
      ],
      cwd,
    };

    return runEffect(
      inferInnerVerifyCommands([outer]).pipe(
        Effect.tap((inferred) => {
          assert.equal(inferred.length, 1);
          assert.equal(inferred[0]?.tier, "inner");
          assert.ok(
            inferred[0]?.args.some((a) =>
              a.includes("test_notification_service.py"),
            ),
          );
          assert.ok(
            !inferred[0]?.args.some((a) => a.includes("integration")),
          );
        }),
        Effect.asVoid,
      ),
    );
  });
});
