import { createWriteStream, existsSync, mkdirSync, symlinkSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { stateDirForEpic } from "../paths.js";
import { appendSessionHistory, sessionHistoryPath } from "./transcript.js";

export class ServeLogger {
  readonly logPath: string;
  readonly epic: string;
  private readonly stream: NodeJS.WritableStream;
  private readonly origOut: typeof process.stdout.write;
  private readonly origErr: typeof process.stderr.write;

  private constructor(epic: string, logPath: string, stream: NodeJS.WritableStream) {
    this.epic = epic;
    this.logPath = logPath;
    this.stream = stream;
    this.origOut = process.stdout.write.bind(process.stdout);
    this.origErr = process.stderr.write.bind(process.stderr);
  }

  static open(epic: string): ServeLogger {
    const dir = stateDirForEpic(epic);
    mkdirSync(dir, { recursive: true });
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
    const stream = createWriteStream(logPath, { flags: "a" });
    appendSessionHistory(
      epic,
      `\n════ serve ${stamp} ════ log=${logPath} history=${sessionHistoryPath(epic)}\n`,
    );
    return new ServeLogger(epic, logPath, stream);
  }

  private tee(text: string): void {
    this.stream.write(text);
    appendSessionHistory(this.epic, text);
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

export function serveLogPath(epic: string): string | undefined {
  const latest = join(stateDirForEpic(epic), "serve-latest.log");
  return existsSync(latest) ? latest : undefined;
}
