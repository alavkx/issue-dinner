export const SELF_HEAL_FLAG = "--self-heal";
export const NO_SELF_HEAL_FLAG = "--no-self-heal";

/** Self-heal is on by default; pass `--no-self-heal` to disable. */
export function isSelfHealEnabled(args: ReadonlyArray<string>): boolean {
  if (args.includes(NO_SELF_HEAL_FLAG)) return false;
  return true;
}

/** Flags to append when spawning serve from launch/tmux. */
export function selfHealInvocationFlags(enabled: boolean): ReadonlyArray<string> {
  return enabled ? [] : [NO_SELF_HEAL_FLAG];
}
