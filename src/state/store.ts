import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type IssueRunStatus =
  | "pending"
  | "running"
  | "finished"
  | "error"
  | "cancelled"
  | "skipped";

export interface IssueRunRecord {
  issueKey: string;
  summary: string;
  status: IssueRunStatus;
  workspace?: string;
  cwd?: string;
  agentId?: string;
  runId?: string;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
  resultPreview?: string;
}

export interface DinnerState {
  version: 1;
  epic?: string;
  issues: Record<string, IssueRunRecord>;
}

const DEFAULT_STATE: DinnerState = { version: 1, issues: {} };

export class StateStore {
  private readonly path: string;
  private data: DinnerState;

  constructor(stateDir: string) {
    mkdirSync(stateDir, { recursive: true });
    this.path = join(stateDir, "runs.json");
    this.data = this.load();
  }

  private load(): DinnerState {
    if (!existsSync(this.path)) return structuredClone(DEFAULT_STATE);
    try {
      return JSON.parse(readFileSync(this.path, "utf8")) as DinnerState;
    } catch {
      return structuredClone(DEFAULT_STATE);
    }
  }

  save(): void {
    writeFileSync(this.path, JSON.stringify(this.data, null, 2));
  }

  get(key: string): IssueRunRecord | undefined {
    return this.data.issues[key];
  }

  list(): IssueRunRecord[] {
    return Object.values(this.data.issues);
  }

  setEpic(epic: string): void {
    this.data.epic = epic;
    this.save();
  }

  upsert(record: IssueRunRecord): void {
    this.data.issues[record.issueKey] = record;
    this.save();
  }

  isDone(key: string): boolean {
    const s = this.data.issues[key]?.status;
    return s === "finished" || s === "skipped";
  }

  canProcess(issueKey: string, blockedBy: string[]): { ok: boolean; reason?: string } {
    for (const blocker of blockedBy) {
      if (!this.isDone(blocker)) {
        return {
          ok: false,
          reason: `Blocked by ${blocker} (status: ${this.data.issues[blocker]?.status ?? "not started"})`,
        };
      }
    }
    return { ok: true };
  }
}
