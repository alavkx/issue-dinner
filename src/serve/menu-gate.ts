import type { JiraIssue } from "../jira/acli.js";
import { StateStore } from "../state/store.js";
import * as Effect from "effect/Effect";

/**
 * Enforce stacked-menu order: every prior course must be verified (or skipped this run)
 * before starting the next. Jira `blockedBy` alone is not enough for Graphite stacks.
 */
export const menuOrderBlocks = (
  menu: JiraIssue[],
  index: number,
  skippedThisRun: ReadonlySet<string>,
): Effect.Effect<
  { ok: boolean; reason?: string; blockerKey?: string },
  never,
  StateStore
> =>
  Effect.gen(function* () {
    const store = yield* StateStore;
    const current = menu[index];
    if (!current) return { ok: true };

    for (let i = 0; i < index; i++) {
      const prev = menu[i]!;
      if (skippedThisRun.has(prev.key)) continue;
      if (yield* store.isVerified(prev.key)) continue;

      const st = (yield* store.get(prev.key))?.status ?? "pending";
      return {
        ok: false,
        blockerKey: prev.key,
        reason: `Prior course ${prev.key} is ${st} — verify or fix before ${current.key}`,
      };
    }
    return { ok: true };
  });
