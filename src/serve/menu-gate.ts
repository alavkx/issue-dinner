import type { JiraIssue } from "../jira/acli.js";
import type { StateStore } from "../state/store.js";

/**
 * Enforce stacked-menu order: every prior course must be verified (or skipped this run)
 * before starting the next. Jira `blockedBy` alone is not enough for Graphite stacks.
 */
export function menuOrderBlocks(
  store: StateStore,
  menu: JiraIssue[],
  index: number,
  skippedThisRun: ReadonlySet<string>,
): { ok: boolean; reason?: string; blockerKey?: string } {
  const current = menu[index];
  if (!current) return { ok: true };

  for (let i = 0; i < index; i++) {
    const prev = menu[i]!;
    if (skippedThisRun.has(prev.key)) continue;
    if (store.isVerified(prev.key)) continue;

    const st = store.get(prev.key)?.status ?? "pending";
    return {
      ok: false,
      blockerKey: prev.key,
      reason: `Prior course ${prev.key} is ${st} — verify or fix before ${current.key}`,
    };
  }
  return { ok: true };
}
