import assert from "node:assert/strict";
import type { SDKMessage } from "@cursor/sdk";
import { describe, it } from "node:test";
import { drainRunStream } from "./stream-handler.js";

async function* canceledStream(): AsyncIterable<SDKMessage> {
  yield {
    type: "assistant",
    agent_id: "a",
    run_id: "r",
    message: { role: "assistant", content: [] },
  };
  throw Object.assign(new Error("This operation was aborted"), {
    name: "ConnectError",
    code: 1,
  });
}

describe("drainRunStream", () => {
  it("returns canceled instead of throwing on SDK abort", async () => {
    const result = await drainRunStream(canceledStream(), {
      writeStdout: () => {},
      writeStderr: () => {},
    });
    assert.equal(result.canceled, true);
  });
});
