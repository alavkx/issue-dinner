import type { SDKMessage } from "@cursor/sdk";
import { isSdkCanceledError } from "./sdk-errors.js";
import { fg } from "../ui/theme.js";

export interface DrainStreamResult {
  canceled: boolean;
}

export interface StreamSink {
  writeStdout(text: string): void;
  writeStderr(text: string): void;
  transcript?(text: string): void;
}

const defaultSink: StreamSink = {
  writeStdout: (t) => process.stdout.write(t),
  writeStderr: (t) => process.stderr.write(t),
};

function tee(sink: StreamSink, text: string, channel: "out" | "err"): void {
  if (channel === "out") sink.writeStdout(text);
  else sink.writeStderr(text);
  sink.transcript?.(text);
}

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
): void {
  switch (event.type) {
    case "assistant": {
      for (const block of event.message.content) {
        if (block.type === "text" && block.text) {
          tee(sink, block.text, "out");
        }
        if (block.type === "tool_use") {
          const line = `${fg.cyan("⚙")} ${fg.bold(block.name)} ${fg.dim("(queued)")}\n`;
          tee(sink, line, "err");
        }
      }
      break;
    }
    case "thinking": {
      if (event.text) {
        tee(sink, fg.dim(event.text), "err");
      }
      break;
    }
    case "tool_call": {
      tee(sink, formatToolCall(event), "err");
      break;
    }
    case "status": {
      const line = `${fg.blue("◦")} ${event.status}${event.message ? ` — ${event.message}` : ""}\n`;
      tee(sink, fg.dim(line), "err");
      break;
    }
    case "task": {
      if (event.text) {
        tee(sink, `${fg.magenta("▹")} ${event.text}\n`, "err");
      }
      break;
    }
    case "system": {
      const tools = event.tools?.length ? ` tools=${event.tools.length}` : "";
      tee(
        sink,
        fg.dim(`system init run=${event.run_id} model=${event.model?.id ?? "?"}${tools}\n`),
        "err",
      );
      break;
    }
    case "user":
    case "request":
      break;
  }
}

export async function drainRunStream(
  stream: AsyncIterable<SDKMessage>,
  sink: StreamSink = defaultSink,
): Promise<DrainStreamResult> {
  try {
    for await (const event of stream) {
      handleStreamEvent(event, sink);
    }
    return { canceled: false };
  } catch (err) {
    if (isSdkCanceledError(err)) {
      return { canceled: true };
    }
    throw err;
  }
}
