import { appendFileSync, createWriteStream, existsSync, symlinkSync, unlinkSync } from "node:fs";
import * as FileSystem from "@effect/platform/FileSystem";
import * as Effect from "effect/Effect";
import { join } from "node:path";
import { stateDirForEpic } from "../paths.js";
import { appendSessionHistory, sessionHistoryPath } from "./transcript.js";

export class ServeLogger {
  readonly logPath: string;
  readonly epic: string;
  private readonly historyPath: string;
  private readonly stream: NodeJS.WritableStream;
  private readonly origOut: typeof process.stdout.write;
  private readonly origErr: typeof process.stderr.write;

  constructor(
    epic: string,
    logPath: string,
    historyPath: string,
    stream: NodeJS.WritableStream,
  ) {
    this.epic = epic;
    this.logPath = logPath;
    this.historyPath = historyPath;
    this.stream = stream;
    this.origOut = process.stdout.write.bind(process.stdout);
    this.origErr = process.stderr.write.bind(process.stderr);
  }

  private tee(text: string): void {
    this.stream.write(text);
    appendFileSync(this.historyPath, text, "utf8");
  }

  attach(): void {
    process.stdout.write = ((chunk, encoding, cb) => {
      const text =
        typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
      this.tee(text);
      return this.origOut(chunk, encoding as BufferEncoding, cb);
    }) as typeof process.stdout.write;

    process.stderr.write = ((chunk, encoding, cb) => {
      const text =
        typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
      this.tee(text);
      return this.origErr(chunk, encoding as BufferEncoding, cb);
    }) as typeof process.stderr.write;
  }

  close(): void {
    process.stdout.write = this.origOut;
    process.stderr.write = this.origErr;
    this.stream.end();
  }
}

type PlatformError = import("@effect/platform/Error").PlatformError;

export const openServeLogger = (
  epic: string,
): Effect.Effect<ServeLogger, PlatformError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = stateDirForEpic(epic);
    yield* fs.makeDirectory(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const logPath = join(dir, `serve-${stamp}.log`);
    const latest = join(dir, "serve-latest.log");
    if (existsSync(latest)) {
      try {
        unlinkSync(latest);
      } catch {
        /* ignore */
      }
    }
    try {
      symlinkSync(logPath, latest);
    } catch {
      /* ignore */
    }
    const historyPath = sessionHistoryPath(epic);
    yield* appendSessionHistory(
      epic,
      `\n════ serve ${stamp} ════ log=${logPath} history=${historyPath}\n`,
    );
    const stream = createWriteStream(logPath, { flags: "a" });
    return new ServeLogger(epic, logPath, historyPath, stream);
  });

export const serveLogPath = (
  epic: string,
): Effect.Effect<string | undefined, PlatformError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const latest = join(stateDirForEpic(epic), "serve-latest.log");
    return (yield* fs.exists(latest)) ? latest : undefined;
  });