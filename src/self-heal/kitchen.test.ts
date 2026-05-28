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
  kitchenApplied,
  MANIFEST_FILE,
} from "./patch.js";
import { formatHealStatus, getHealStatus } from "./kitchen.js";

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
      /heal contribute/,
    );
  });
});

describe("getHealStatus", () => {
  it("lists durable heals and pending contribution", () =>
    withHealRoot(({ root }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const prevState = process.env.ISSUE_DINNER_STATE_DIR;
        const stateDir = yield* fs.makeTempDirectory();
        process.env.ISSUE_DINNER_STATE_DIR = stateDir;

        try {
          yield* fs.makeDirectory(join(stateDir, "heals", "heal-a"), {
            recursive: true,
          });
          yield* fs.writeFileString(
            join(stateDir, "heals", "heal-a", MANIFEST_FILE),
            JSON.stringify({
              id: "heal-a",
              issueKey: "CPD-1",
              reason: "test",
              files: [{ path: "src/x.ts", content: "x\n" }],
            }),
          );

          const appliedDir = join(kitchenApplied(root), "heal-a");
          yield* fs.makeDirectory(appliedDir, { recursive: true });
          yield* fs.writeFileString(
            join(appliedDir, MANIFEST_FILE),
            JSON.stringify({
              id: "heal-a",
              issueKey: "CPD-1",
              reason: "test",
              files: [{ path: "src/x.ts", content: "x\n" }],
            }),
          );

          const status = yield* getHealStatus();
          assert.equal(status.durable.length, 1);
          assert.deepEqual(status.pendingContribution, ["heal-a"]);
          assert.match(formatHealStatus(status), /heal-a/);
        } finally {
          if (prevState === undefined) delete process.env.ISSUE_DINNER_STATE_DIR;
          else process.env.ISSUE_DINNER_STATE_DIR = prevState;
        }
      }),
    ));
});

describe("contributeAppliedPatches", () => {
  it("opens a PR for an applied patch using the git port", () =>
    withHealRoot(({ root }) =>
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

function withHealRoot<A, E, R>(
  run: (ctx: { root: string }) => Effect.Effect<A, E, R>,
): Promise<A> {
  const prevRoot = process.env.ISSUE_DINNER_ROOT;
  return runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectory({ prefix: "issue-dinner-heal-" });
      process.env.ISSUE_DINNER_ROOT = root;
      yield* fs.writeFileString(
        join(root, "package.json"),
        JSON.stringify({ name: "issue-dinner" }),
      );
      yield* fs.makeDirectory(join(root, "src"), { recursive: true });
      yield* fs.makeDirectory(kitchenApplied(root), { recursive: true });
      return yield* run({ root });
    }).pipe(Effect.provide(PlatformLive)),
  ).finally(() => {
    if (prevRoot === undefined) delete process.env.ISSUE_DINNER_ROOT;
    else process.env.ISSUE_DINNER_ROOT = prevRoot;
  });
}
