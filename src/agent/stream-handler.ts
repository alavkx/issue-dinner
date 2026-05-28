import type { SDKMessage } from "@cursor/sdk";
import * as FileSystem from "@effect/platform/FileSystem";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { isSdkCanceledError } from "./sdk-errors.js";
import { fg } from "../ui/theme.js";

export interface DrainStreamResult {
  canceled: boolean;
}

export interface StreamSink {
  writeStdout(text: string): void;
  writeStderr(text: string): void;
  appendTranscript?: (
    text: string,
  ) => Effect.Effect<void, unknown, FileSystem.FileSystem>;
}

const defaultSink: StreamSink = {
  writeStdout: (t) => process.stdout.write(t),
  writeStderr: (t) => process.stderr.write(t),
};

const tee = (
  sink: StreamSink,
  text: string,
  channel: "out" | "err",
): Effect.Effect<void, unknown, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    if (channel === "out") sink.writeStdout(text);
    else sink.writeStderr(text);
    if (sink.appendTranscript) yield* sink.appendTranscript(text);
  });

function formatToolCall(msg: Extract<SDKMessage, { type: "tool_call" }>): string {
  const status =
    msg.status === "completed"
      ? fg.green("done")
      : msg.status === "error"
        ? fg.red("error")
        : fg.cyan("running");
  return `${fg.cyan("⚙")} ${fg.bold(msg.name)} ${status}\n`;
}

export function handleStreamEvent(
  event: SDKMessage,
  sink: StreamSink = defaultSink,
): Effect.Effect<void, unknown, FileSystem.FileSystem> {
  switch (event.type) {
    case "assistant": {
      return Effect.gen(function* () {
        for (const block of event.message.content) {
          if (block.type === "text" && block.text) {
            yield* tee(sink, block.text, "out");
          }
          if (block.type === "tool_use") {
            const line = `${fg.cyan("⚙")} ${fg.bold(block.name)} ${fg.dim("(queued)")}\n`;
            yield* tee(sink, line, "err");
          }
        }
      });
    }
    case "thinking": {
      if (event.text) {
        return tee(sink, fg.dim(event.text), "err");
      }
      break;
    }
    case "tool_call": {
      return tee(sink, formatToolCall(event), "err");
    }
    case "status": {
      const line = `${fg.blue("◦")} ${event.status}${event.message ? ` — ${event.message}` : ""}\n`;
      return tee(sink, fg.dim(line), "err");
    }
    case "task": {
      if (event.text) {
        return tee(sink, `${fg.magenta("▹")} ${event.text}\n`, "err");
      }
      break;
    }
    case "system": {
      const tools = event.tools?.length ? ` tools=${event.tools.length}` : "";
      return tee(
        sink,
        fg.dim(`system init run=${event.run_id} model=${event.model?.id ?? "?"}${tools}\n`),
        "err",
      );
    }
    case "user":
    case "request":
      break;
  }
  return Effect.void;
}

export const drainRunStream = (
  stream: AsyncIterable<SDKMessage>,
  sink: StreamSink = defaultSink,
): Effect.Effect<DrainStreamResult, unknown, FileSystem.FileSystem> =>
  Stream.fromAsyncIterable(stream, (err) => err).pipe(
    Stream.runForEach((event) => handleStreamEvent(event, sink)),
    Effect.map(() => ({ canceled: false as const })),
    Effect.catchAll((err) =>
      isSdkCanceledError(err)
        ? Effect.succeed({ canceled: true as const })
        : Effect.fail(err),
    ),
  );
