import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { join } from "node:path";
import { runEffect } from "../effect/test-runtime.js";
import { ensureLocalSdkLink } from "./link-local-sdk.js";
import * as FileSystem from "@effect/platform/FileSystem";
import * as Effect from "effect/Effect";

const CLIENT_PACKAGE = "@acme/api-client";

describe("ensureLocalSdkLink", () => {
  it("writes file: dependency relative to frontend cwd", () =>
    runEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectory({ prefix: "link-sdk-" });
        const sdk = join(root, "ts-client");
        const frontend = join(root, "app-frontend");
        yield* fs.makeDirectory(sdk, { recursive: true });
        yield* fs.makeDirectory(frontend, { recursive: true });
        yield* fs.writeFileString(
          join(frontend, "package.json"),
          JSON.stringify(
            {
              name: "test-app",
              dependencies: { [CLIENT_PACKAGE]: "10.0.0" },
            },
            null,
            2,
          ),
        );

        const result = yield* ensureLocalSdkLink(frontend, sdk, CLIENT_PACKAGE).pipe(
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
        assert.match(result.detail, /^file:\.\.\/ts-client$/);
        const updated = JSON.parse(
          yield* fs.readFileString(join(frontend, "package.json")),
        ) as { dependencies: Record<string, string> };
        assert.equal(
          updated.dependencies[CLIENT_PACKAGE],
          "file:../ts-client",
        );
      }),
    ));
});
