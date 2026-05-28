import assert from "node:assert/strict";
import { join } from "node:path";
import * as FileSystem from "@effect/platform/FileSystem";
import * as Effect from "effect/Effect";
import { describe, it } from "node:test";
import { runEffect } from "../effect/test-runtime.js";
import { diffSrcSnapshot, snapshotSrcFiles } from "./durable-patches.js";
import {
  buildInlineHealBuildPrompt,
  buildInlineHealTypecheckPrompt,
} from "./heal-prompt.js";
import {
  attemptInlineHealFromCourse,
  finalizeInlineHeal,
} from "./inline-heal.js";
import type { ServeHealContext } from "./heal-agent.js";

const testIssue = {
  key: "CPD-1",
  summary: "test",
  status: "Open",
  description: "",
  parsed: { acceptanceCriteria: [], blockedBy: [] },
};

const testConfig = {
  model: "composer-2.5",
  workspaces: { backend: "/tmp/backend" },
  defaultWorkspace: "backend",
  settingSources: ["project"] as const,
  requireVerify: true,
  serveVerifyGate: "inner" as const,
  requireHandoffTests: true,
  graphiteTrunk: "main",
  blockerPolicy: "strict" as const,
  commitWip: true,
  recoveryAttempts: 2,
  healAttempts: 3,
  healTypecheckIterations: 8,
  quietRecovery: true,
};

const testRoots = {
  primaryKey: "backend",
  keys: ["backend"],
  cwds: ["/tmp/backend"],
};

const testServeHeal: ServeHealContext = {
  serveArgv: ["CPD-1", "serve"],
  courseIndex: 0,
  epic: "CPD-1",
};

describe("inline-heal prompts", () => {
  it("builds inline typecheck feedback for course agent", () => {
    const prompt = buildInlineHealTypecheckPrompt({
      kitchenRoot: "/tmp/issue-dinner",
      errors: "src/foo.ts(1,1): error TS1005",
      iteration: 1,
      maxIterations: 8,
    });
    assert.match(prompt, /inline heal — typecheck feedback \(1\/8\)/);
    assert.match(prompt, /\/tmp\/issue-dinner/);
    assert.match(prompt, /TS1005/);
  });

  it("builds inline build feedback for course agent", () => {
    const prompt = buildInlineHealBuildPrompt({
      kitchenRoot: "/tmp/issue-dinner",
      errors: "build failed",
      iteration: 2,
      maxIterations: 8,
    });
    assert.match(prompt, /inline heal — build feedback \(2\/8\)/);
    assert.match(prompt, /build failed/);
  });
});

describe("attemptInlineHealFromCourse", () => {
  it("skips when serve context is missing", async () => {
    const result = await runEffect(
      attemptInlineHealFromCourse({
        issue: testIssue,
        config: testConfig,
        apiKey: "test-key",
        selfHeal: true,
        kitchenRoot: "/tmp/issue-dinner",
        roots: testRoots,
        baseline: new Map([["src/cli.ts", "unchanged"]]),
      }),
    );
    assert.equal(result, undefined);
  });
});

describe("finalizeInlineHeal", () => {
  it("returns no_changes when src matches baseline", () =>
    runEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const kitchenRoot = yield* fs.makeTempDirectory();
        yield* fs.makeDirectory(join(kitchenRoot, "src"), { recursive: true });
        yield* fs.writeFileString(
          join(kitchenRoot, "src", "x.ts"),
          "export const x = 1;\n",
        );
        const baseline = yield* snapshotSrcFiles(kitchenRoot);

        const result = yield* finalizeInlineHeal({
          issue: testIssue,
          kitchenRoot,
          config: testConfig,
          apiKey: "test-key",
          roots: testRoots,
          serveHeal: testServeHeal,
          baseline,
        });

        assert.equal(result.outcome, "no_changes");
        assert.equal(result.restarted, false);
      }),
    ));

  it("returns exhausted when src changed, typecheck fails, and no course agent", () =>
    runEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const kitchenRoot = yield* fs.makeTempDirectory();
        yield* fs.writeFileString(
          join(kitchenRoot, "package.json"),
          `${JSON.stringify({
            scripts: {
              typecheck: "tsc -p tsconfig.json --noEmit",
              build: "tsc -p tsconfig.json",
            },
          })}\n`,
        );
        yield* fs.writeFileString(
          join(kitchenRoot, "tsconfig.json"),
          `${JSON.stringify({
            compilerOptions: {
              target: "ES2022",
              module: "NodeNext",
              moduleResolution: "NodeNext",
              strict: true,
              outDir: "dist",
              rootDir: "src",
            },
            include: ["src/**/*"],
          })}\n`,
        );
        yield* fs.makeDirectory(join(kitchenRoot, "src"), { recursive: true });
        yield* fs.writeFileString(
          join(kitchenRoot, "src", "broken.ts"),
          "const x: number = 'bad';\n",
        );

        const baseline = new Map([
          ["src/broken.ts", "const x: number = 1;\n"],
        ]);

        const result = yield* finalizeInlineHeal({
          issue: testIssue,
          kitchenRoot,
          config: testConfig,
          apiKey: "test-key",
          roots: testRoots,
          serveHeal: testServeHeal,
          baseline,
        });

        assert.equal(result.outcome, "exhausted");
        assert.equal(result.restarted, false);
        assert.match(result.error ?? "", /no course agent/i);
      }),
    ));
});

describe("inline heal diff detection", () => {
  it("detects src changes from baseline", () => {
    const baseline = new Map([
      ["src/a.ts", "a"],
      ["src/b.ts", "b"],
    ]);
    const current = new Map([
      ["src/a.ts", "a-fixed"],
      ["src/b.ts", "b"],
    ]);
    const changed = diffSrcSnapshot(baseline, current);
    assert.equal(changed.length, 1);
    assert.equal(changed[0]?.path, "src/a.ts");
    assert.equal(changed[0]?.content, "a-fixed");
  });
});
