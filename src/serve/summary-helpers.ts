import type { IssueRunRecord } from "../state/store.js";
import { isResolutionNoise } from "./explain.js";

const RECOVERY_ATTEMPT = /^Recovery \w+ attempt \d+\/\d+$/;
export function countRecoveryAttempts(steps: ReadonlyArray<string> | undefined): number {
  return (steps ?? []).filter((s) => RECOVERY_ATTEMPT.test(s)).length;
}

export function meaningfulResolutionSteps(
  steps: ReadonlyArray<string> | undefined,
): string[] {
  return (steps ?? []).filter((s) => !isResolutionNoise(s));
}

export function wasRecovered(rec: IssueRunRecord | undefined): boolean {
  if (!rec || (rec.status !== "verified" && rec.status !== "finished")) {
    return false;
  }
  return countRecoveryAttempts(rec.resolutionSteps) > 0;
}

export function extractHandoffExcerpt(preview: string | undefined): string | undefined {
  if (!preview?.trim()) return undefined;

  const sections = new Map<string, string[]>();
  let current = "";
  for (const line of preview.split("\n")) {
    const heading = line.match(/^##\s+(.+)$/);
    if (heading?.[1]) {
      current = heading[1].trim().toLowerCase();
      sections.set(current, []);
      continue;
    }
    if (current) sections.get(current)?.push(line);
  }

  const pickBullet = (sectionName: string): string | undefined => {
    for (const line of sections.get(sectionName) ?? []) {
      const trimmed = line.trim();
      if (trimmed.startsWith("- ")) {
        const body = trimmed.slice(2).trim();
        if (body.length > 0) return body.slice(0, 160);
      }
    }
    return undefined;
  };

  return (
    pickBullet("measurements") ??
    pickBullet("what i did") ??
    pickBullet("suggested follow-ups")
  );
}

export function extractManualVerificationItems(
  preview: string | undefined,
): string[] {
  if (!preview) return [];
  const items: string[] = [];
  for (const line of preview.split("\n")) {
    const match = line.match(/^\s*\d+\.\s*\[\s\]\s*(.+)$/);
    if (match?.[1]) {
      items.push(match[1].trim().slice(0, 120));
    }
  }
  return items;
}

export function formatDuration(fromIso: string, to = Date.now()): string {
  const ms = Math.max(0, to - Date.parse(fromIso));
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "<1m";
  const hours = Math.floor(minutes / 60);
  const rem = minutes % 60;
  if (hours === 0) return `${minutes}m`;
  if (rem === 0) return `${hours}h`;
  return `${hours}h ${rem}m`;
}

export function formatKeyList(keys: ReadonlyArray<string>): string {
  if (keys.length === 0) return "";
  if (keys.length <= 4) return keys.join(", ");
  return `${keys.slice(0, 3).join(", ")} +${keys.length - 3} more`;
}
