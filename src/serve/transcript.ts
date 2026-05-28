import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { stateDirForEpic } from "../paths.js";

export class Transcript {
  readonly path: string;

  constructor(epic: string, issueKey: string) {
    const dir = join(stateDirForEpic(epic), "transcripts");
    mkdirSync(dir, { recursive: true });
    this.path = join(dir, `${issueKey}.log`);
  }

  append(text: string): void {
    appendFileSync(this.path, text, "utf8");
  }

  appendLine(line: string): void {
    const ts = new Date().toISOString();
    this.append(`[${ts}] ${line}\n`);
  }

  appendBlock(label: string, body: string): void {
    this.appendLine(`── ${label} ──`);
    for (const line of body.split("\n")) {
      this.append(`  ${line}\n`);
    }
  }
}

export function sessionHistoryPath(epic: string): string {
  return join(stateDirForEpic(epic), "session-history.log");
}

export function appendSessionHistory(epic: string, text: string): void {
  const path = sessionHistoryPath(epic);
  mkdirSync(stateDirForEpic(epic), { recursive: true });
  appendFileSync(path, text, "utf8");
}

export function tailSessionHistory(epic: string, lines = 80): string {
  const path = sessionHistoryPath(epic);
  if (!existsSync(path)) return "";
  const content = readFileSync(path, "utf8");
  return content.split("\n").slice(-lines).join("\n");
}

export function formatAttachReplay(epic: string, lines = 80): string {
  const tail = tailSessionHistory(epic, lines);
  if (!tail.trim()) return "";
  return [
    "",
    "──────────────── recent session history ────────────────",
    tail,
    "──────────────── live output below ───────────────────",
    "",
  ].join("\n");
}
