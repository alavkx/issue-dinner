import {
  selfHealInvocationFlags,
} from "../runtime/self-heal-flags.js";
import {
  WATCH_FLAG,
  WATCH_RESTART_ON_CRASH_FLAG,
} from "../runtime/watchdog.js";
import { shellQuote } from "../util/exec.js";

export interface ServeInvocationFlags {
  continueOnError?: boolean;
  skipDone?: boolean;
  exclude?: string;
  only?: string;
  force?: boolean;
  skipVerify?: boolean;
  skipPreflight?: boolean;
  dryRun?: boolean;
  selfHeal?: boolean;
  watch?: boolean;
  watchRestartOnCrash?: boolean;
}

export function buildServeInvocation(
  cliExecutable: string,
  epic: string,
  configPath: string | undefined,
  flags: ServeInvocationFlags,
): string {
  const parts = [shellQuote(cliExecutable), shellQuote(epic)];
  if (configPath) parts.push("-c", shellQuote(configPath));
  parts.push("serve");
  if (flags.dryRun) parts.push("--dry-run");
  if (flags.skipDone) parts.push("--skip-done");
  if (flags.continueOnError) parts.push("--continue-on-error");
  if (flags.force) parts.push("--force");
  if (flags.skipVerify) parts.push("--skip-verify");
  if (flags.skipPreflight) parts.push("--skip-preflight");
  parts.push(...selfHealInvocationFlags(flags.selfHeal ?? true));
  if (flags.watch) parts.push(WATCH_FLAG);
  if (flags.watchRestartOnCrash) parts.push(WATCH_RESTART_ON_CRASH_FLAG);
  if (flags.only) parts.push("--only", shellQuote(flags.only));
  if (flags.exclude) parts.push("--exclude", shellQuote(flags.exclude));
  return parts.join(" ");
}
