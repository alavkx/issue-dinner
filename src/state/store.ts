import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type IssueRunStatus =
  | "pending"
  | "running"
  | "agent_complete"
  | "verified"
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
  verifyError?: string;
  resultPreview?: string;
  handoffStatus?: string;
  handoffVerification?: string;
  verifyOutput?: string;
  /** workspace key → branch name after checkout */
  branches?: Record<string, string>;
  /** workspace key → short commit sha after WIP commit */
  commits?: Record<string, string>;
  /** Human-readable recovery / interruption trail for status and resume */
  resolutionSteps?: string[];
  transcriptPath?: string;
}

export interface DinnerState {
  version: 1;
  epic?: string;
  issues: Record<string, IssueRunRecord>;
}

const DEFAULT_STATE: DinnerState = { version: 1, issues: {} };

export type BlockerPolicy = "strict" | "agent_complete";

export class StateStore {
  private readonly path: string;
  private data: DinnerState;
  private blockerPolicy: BlockerPolicy;

  constructor(stateDir: string, blockerPolicy: BlockerPolicy = "strict") {
    mkdirSync(stateDir, { recursive: true });
    this.path = join(stateDir, "runs.json");
    this.data = this.load();
    this.blockerPolicy = blockerPolicy;
  }

  setBlockerPolicy(policy: BlockerPolicy): void {
    this.blockerPolicy = policy;
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
    const prev = this.data.issues[record.issueKey];
    if (prev?.resolutionSteps && record.resolutionSteps === undefined) {
      record = { ...record, resolutionSteps: prev.resolutionSteps };
    }
    this.data.issues[record.issueKey] = record;
    this.save();
  }

  appendResolutionStep(issueKey: string, step: string): void {
    const rec = this.data.issues[issueKey];
    const steps = [...(rec?.resolutionSteps ?? []), step];
    if (rec) {
      this.data.issues[issueKey] = { ...rec, resolutionSteps: steps };
    } else {
      this.data.issues[issueKey] = {
        issueKey,
        summary: issueKey,
        status: "pending",
        resolutionSteps: steps,
      };
    }
    this.save();
  }

  isDone(key: string): boolean {
    const s = this.data.issues[key]?.status;
    if (s === "verified" || s === "finished" || s === "skipped") return true;
    if (this.blockerPolicy === "agent_complete" && s === "agent_complete") {
      return true;
    }
    return false;
  }

  isVerified(key: string): boolean {
    const s = this.data.issues[key]?.status;
    return s === "verified" || s === "finished";
  }

  canProcess(
    issueKey: string,
    blockedBy: string[],
  ): { ok: boolean; reason?: string } {
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

  /** Reset courses stuck in running (interrupted serve). */
  recoverStaleRunning(): string[] {
    const recovered: string[] = [];
    for (const [key, rec] of Object.entries(this.data.issues)) {
      if (rec.status === "running") {
        const steps = [
          ...(rec.resolutionSteps ?? []),
          "Serve interrupted while issue was running (crash, Ctrl+C, or agent stall)",
          `Resume: issue-dinner ${this.data.epic ?? "EPIC"} serve --only ${key}` +
            `  # or cook ${key} --force`,
        ];
        this.data.issues[key] = {
          ...rec,
          status: "error",
          error: "Recovered stale running state (previous serve interrupted)",
          resolutionSteps: steps,
          finishedAt: new Date().toISOString(),
        };
        recovered.push(key);
      }
    }
    if (recovered.length > 0) this.save();
    return recovered;
  }
}
