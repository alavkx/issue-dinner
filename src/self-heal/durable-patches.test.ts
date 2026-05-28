import assert from "node:assert/strict";
import { join } from "node:path";
import * as FileSystem from "@effect/platform/FileSystem";
import * as Effect from "effect/Effect";
import { describe, it } from "node:test";
import { runEffect } from "../effect/test-runtime.js";
import {
  diffSrcSnapshot,
  persistDurableHeal,
  readDurableManifest,
  snapshotSrcFiles,
  syncDurableHealsToPackage,
} from "./durable-patches.js";

describe("durable-patches", () => {
  it("snapshots and diffs src files", () =>
    runEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectory();
        yield* fs.makeDirectory(join(root, "src"), { recursive: true });
        yield* fs.writeFileString(join(root, "src", "a.ts"), "a\n");
        const before = yield* snapshotSrcFiles(root);
        yield* fs.writeFileString(join(root, "src", "a.ts"), "a patched\n");
        yield* fs.writeFileString(join(root, "src", "b.ts"), "b\n");
        const after = yield* snapshotSrcFiles(root);
        const diff = diffSrcSnapshot(before, after);
        assert.equal(diff.length, 2);
        assert.ok(diff.some((d) => d.path === "src/a.ts" && d.content.includes("patched")));
      }),
    ));

  it("persists and syncs durable heals", () =>
    runEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const pkgRoot = yield* fs.makeTempDirectory();
        yield* fs.makeDirectory(join(pkgRoot, "src"), { recursive: true });
        yield* fs.writeFileString(join(pkgRoot, "src", "existing.ts"), "old\n");

        const prevHealDir = process.env.ISSUE_DINNER_STATE_DIR;
        const stateDir = yield* fs.makeTempDirectory();
        process.env.ISSUE_DINNER_STATE_DIR = stateDir;

        try {
          yield* persistDurableHeal({
            id: "heal-test-1",
            issueKey: "CPD-1",
            reason: "test fix",
            files: [{ path: "src/existing.ts", content: "new\n" }],
          });

          const manifest = yield* readDurableManifest("heal-test-1");
          assert.equal(manifest.reason, "test fix");

          const synced = yield* syncDurableHealsToPackage(pkgRoot);
          assert.deepEqual(synced, ["heal-test-1"]);
          const content = yield* fs.readFileString(join(pkgRoot, "src", "existing.ts"));
          assert.equal(content, "new\n");
        } finally {
          if (prevHealDir === undefined) delete process.env.ISSUE_DINNER_STATE_DIR;
          else process.env.ISSUE_DINNER_STATE_DIR = prevHealDir;
        }
      }),
    ));
});
