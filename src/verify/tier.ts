import type { VerifyCommand } from "./runner.js";

/** Classify verify commands without requiring manual tier tags in config. */
export function effectiveVerifyTier(cmd: VerifyCommand): "inner" | "outer" {
  if (cmd.tier) return cmd.tier;
  const haystack = [cmd.name, cmd.command, ...cmd.args].join(" ").toLowerCase();
  if (
    haystack.includes("integration") ||
    haystack.includes("/scripts/") ||
    haystack.includes(".sh")
  ) {
    return "outer";
  }
  if (
    haystack.includes("unit_test") ||
    haystack.includes(".test.ts") ||
    haystack.includes(".test.tsx")
  ) {
    return "inner";
  }
  return "inner";
}
