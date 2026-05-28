import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { join } from "node:path";
import { runEffect } from "../effect/test-runtime.js";
import { ensureLocalSdkLink } from "./link-local-sdk.js";
import * as FileSystem from "@effect/platform/FileSystem";
import * as Effect from "effect/Effect";

describe("ensureLocalSdkLink", () => {
  it("writes file: dependency relative to frontend cwd", () =>
    runEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectory({ prefix: "link-sdk-" });
        const sdk = join(root, "istari-ts-client");
        const frontend = join(root, "istari-frontend");
        yield* fs.makeDirectory(sdk, { recursive: true });
        yield* fs.makeDirectory(frontend, { recursive: true });
        yield* fs.writeFileString(
          join(frontend, "package.json"),
          JSON.stringify(
            {
              name: "test-app",
              dependencies: { "@istari/istari-client": "10.0.0" },
            },
            null,
            2,
          ),
        );

        const result = yield* ensureLocalSdkLink(frontend, sdk).pipe(
          Effect.catchAll((err) =>
            Effect.succeed({
              frontendCwd: frontend,
              sdkCwd: sdk,
              linked: false,
              detail: String(err),
            }),
          ),
        );

        assert.equal(result.linked, true);
        assert.match(result.detail, /^file:\.\.\/istari-ts-client$/);
        const updated = JSON.parse(
          yield* fs.readFileString(join(frontend, "package.json")),
        ) as { dependencies: Record<string, string> };
        assert.equal(
          updated.dependencies["@istari/istari-client"],
          "file:../istari-ts-client",
        );
      }),
    ));
});
