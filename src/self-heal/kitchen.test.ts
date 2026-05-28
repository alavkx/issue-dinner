import assert from "node:assert/strict";
import { join } from "node:path";
import * as FileSystem from "@effect/platform/FileSystem";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { describe, it } from "node:test";
import { runEffect } from "../effect/test-runtime.js";
import { PlatformLive } from "../effect/layers.js";
import {
  contributionBranchName,
  contributionCommitMessage,
  contributionPrBody,
  contributionPrTitle,
  contributeAppliedPatches,
  formatContributeReminder,
  KitchenGitPort,
  type KitchenGitCommands,
} from "./contribute.js";
import {
  CONTRIBUTION_FILE,
  KitchenApplyFailed,
  kitchenApplied,
  kitchenInbox,
  MANIFEST_FILE,
} from "./patch.js";
import {
  KitchenBuildPort,
  processKitchenInbox,
  type KitchenBuildCommands,
} from "./kitchen.js";

describe("contribution formatting", () => {
  it("builds branch names, commits, and PR text from manifests", () => {
    const manifest = {
      id: "Fix Recovery Loop!",
      issueKey: "CPD-636",
      reason: "Recovery agent skipped verify retry",
      files: [{ path: "src/agent/recovery.ts", content: "export {}\n" }],
    };

    assert.equal(contributionBranchName(manifest.id), "self-heal/fix-recovery-loop");
    assert.match(contributionCommitMessage(manifest), /fix\(issue-dinner\): Recovery agent/);
    assert.match(contributionCommitMessage(manifest), /CPD-636/);
    assert.equal(
      contributionPrTitle(manifest),
      "fix(issue-dinner): Recovery agent skipped verify retry",
    );
    assert.match(contributionPrBody(manifest, "CPD-635"), /CPD-636/);
    assert.match(contributionPrBody(manifest, "CPD-635"), /CPD-635/);
    assert.match(contributionPrBody(manifest, "CPD-635"), /src\/agent\/recovery.ts/);
  });
});

describe("formatContributeReminder", () => {
  it("returns undefined when nothing is pending", () => {
    assert.equal(formatContributeReminder([]), undefined);
  });

  it("lists pending patch ids", () => {
    assert.match(
      formatContributeReminder(["fix-a", "fix-b"])!,
      /kitchen contribute/,
    );
  });
});

describe("processKitchenInbox", () => {
  it("applies a valid patch and moves it to applied/", () =>
    withKitchenRoot(({ root }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* fs.writeFileString(join(root, "src", "target.ts"), "original\n");

        const patchDir = join(kitchenInbox(root), "fix-target");
        yield* fs.makeDirectory(patchDir, { recursive: true });
        yield* fs.writeFileString(
          join(patchDir, MANIFEST_FILE),
          JSON.stringify({
            id: "fix-target",
            issueKey: "CPD-636",
            reason: "test patch",
            files: [{ path: "src/target.ts", content: "patched\n" }],
          }),
        );

        const result = yield* processKitchenInbox();
        assert.deepEqual(result.applied, ["fix-target"]);
        assert.deepEqual(result.failed, []);
        assert.equal(yield* fs.readFileString(join(root, "src", "target.ts")), "patched\n");
        assert.equal(yield* fs.exists(join(kitchenApplied(root), "fix-target", MANIFEST_FILE)), true);
        assert.equal(yield* fs.exists(join(kitchenInbox(root), "fix-target")), false);
      }),
    ));

  it("rolls back file changes when validation fails", () =>
    withKitchenRoot(
      ({ root }) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          yield* fs.writeFileString(join(root, "src", "target.ts"), "original\n");

          const patchDir = join(kitchenInbox(root), "bad-target");
          yield* fs.makeDirectory(patchDir, { recursive: true });
          yield* fs.writeFileString(
            join(patchDir, MANIFEST_FILE),
            JSON.stringify({
              id: "bad-target",
              files: [{ path: "src/target.ts", content: "broken\n" }],
            }),
          );

          const result = yield* processKitchenInbox();
          assert.deepEqual(result.applied, []);
          assert.deepEqual(result.failed, ["bad-target"]);
          assert.equal(yield* fs.readFileString(join(root, "src", "target.ts")), "original\n");
          assert.equal(yield* fs.exists(join(kitchenInbox(root), "bad-target")), false);
        }),
      Layer.succeed(KitchenBuildPort, {
        validate: (_root, patchId) =>
          Effect.fail(
            new KitchenApplyFailed({
              patchId,
              message: "validation failed",
            }),
          ),
      }),
    ));

  it("rejects invalid manifest JSON in inbox", () =>
    withKitchenRoot(({ root }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const patchDir = join(kitchenInbox(root), "bad-json");
        yield* fs.makeDirectory(patchDir, { recursive: true });
        yield* fs.writeFileString(join(patchDir, MANIFEST_FILE), "{ not json");

        const result = yield* processKitchenInbox().pipe(
          Effect.match({
            onFailure: (err) => err,
            onSuccess: () => "unexpected-success",
          }),
        );
        assert.match(String(result), /Invalid JSON/);
      }),
    ));
});

describe("contributeAppliedPatches", () => {
  it("opens a PR for an applied patch using the git port", () =>
    withKitchenRoot(({ root }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const appliedDir = join(kitchenApplied(root), "fix-target");
        yield* fs.makeDirectory(appliedDir, { recursive: true });
        yield* fs.writeFileString(
          join(appliedDir, MANIFEST_FILE),
          JSON.stringify({
            id: "fix-target",
            issueKey: "CPD-636",
            reason: "test upstream",
            files: [{ path: "src/target.ts", content: "patched\n" }],
          }),
        );

        const calls: string[] = [];
        const git = mockGitPort(calls);
        const result = yield* contributeAppliedPatches().pipe(
          Effect.provide(Layer.succeed(KitchenGitPort, git)),
        );

        assert.deepEqual(result.contributed, ["fix-target"]);
        assert.match(calls.join("\n"), /checkout main/);
        assert.match(calls.join("\n"), /branch self-heal\/fix-target/);
        assert.match(calls.join("\n"), /commit fix\(issue-dinner\)/);
        assert.match(calls.join("\n"), /push origin self-heal\/fix-target/);
        assert.match(calls.join("\n"), /gh pr create/);
        assert.equal(yield* fs.exists(join(appliedDir, CONTRIBUTION_FILE)), true);
      }),
    ));
});

function mockGitPort(calls: string[]): KitchenGitCommands {
  return {
    readBranch: () =>
      Effect.sync(() => {
        calls.push("readBranch");
        return "feature/serve";
      }),
    checkout: (_root, ref) =>
      Effect.sync(() => {
        calls.push(`checkout ${ref}`);
      }),
    createBranch: (_root, branch) =>
      Effect.sync(() => {
        calls.push(`branch ${branch}`);
      }),
    add: (_root, paths) =>
      Effect.sync(() => {
        calls.push(`add ${paths.join(",")}`);
      }),
    commit: (_root, message) =>
      Effect.sync(() => {
        calls.push(`commit ${message.split("\n")[0]}`);
        return "abc123";
      }),
    push: (_root, remote, branch) =>
      Effect.sync(() => {
        calls.push(`push ${remote} ${branch}`);
      }),
    createPullRequest: () =>
      Effect.sync(() => {
        calls.push("gh pr create");
        return "https://github.com/example/issue-dinner/pull/1";
      }),
  };
}

function withKitchenRoot<A, E, R>(
  run: (ctx: { root: string }) => Effect.Effect<A, E, R>,
  extraLayer: Layer.Layer<never, never, KitchenBuildPort> = Layer.succeed(
    KitchenBuildPort,
    { validate: () => Effect.void },
  ),
): Promise<A> {
  const prevRoot = process.env.ISSUE_DINNER_ROOT;
  return runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectory({ prefix: "issue-dinner-kitchen-" });
      process.env.ISSUE_DINNER_ROOT = root;
      yield* fs.writeFileString(
        join(root, "package.json"),
        JSON.stringify({ name: "issue-dinner" }),
      );
      yield* fs.makeDirectory(join(root, "src"), { recursive: true });
      yield* fs.makeDirectory(kitchenInbox(root), { recursive: true });
      yield* fs.makeDirectory(kitchenApplied(root), { recursive: true });
      return yield* run({ root });
    }).pipe(Effect.provide(Layer.mergeAll(PlatformLive, extraLayer))),
  ).finally(() => {
    if (prevRoot === undefined) delete process.env.ISSUE_DINNER_ROOT;
    else process.env.ISSUE_DINNER_ROOT = prevRoot;
  });
}
