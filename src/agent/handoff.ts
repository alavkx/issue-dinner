export type HandoffStatus = "success" | "partial" | "blocked" | "unknown";

export type HandoffVerification =
  | "live-ui-verified"
  | "unit-test-verified"
  | "type-check-only"
  | "not-verified"
  | "verifier-blocked"
  | "verifier-failed"
  | "unknown";

export interface ParsedHandoff {
  status: HandoffStatus;
  verification: HandoffVerification;
  measurements?: string;
  raw: string;
}

function section(text: string, heading: string): string | undefined {
  const re = new RegExp(
    `^##\\s+${heading}\\s*$([\\s\\S]*?)(?=^##\\s+|\\Z)`,
    "im",
  );
  const m = text.match(re);
  return m?.[1]?.trim();
}

function normalizeStatus(value: string | undefined): HandoffStatus {
  const v = value?.trim().toLowerCase();
  if (v === "success") return "success";
  if (v === "partial") return "partial";
  if (v === "blocked") return "blocked";
  return "unknown";
}

function normalizeVerification(
  value: string | undefined,
): HandoffVerification {
  if (!value?.trim()) return "not-verified";
  const v = value.trim().toLowerCase();
  const allowed: HandoffVerification[] = [
    "live-ui-verified",
    "unit-test-verified",
    "type-check-only",
    "not-verified",
    "verifier-blocked",
    "verifier-failed",
  ];
  if (allowed.includes(v as HandoffVerification)) {
    return v as HandoffVerification;
  }
  return "unknown";
}

export function parseHandoff(text: string): ParsedHandoff {
  const status = normalizeStatus(section(text, "Status"));
  const verification = normalizeVerification(section(text, "Verification"));
  const measurements = section(text, "Measurements");
  return { status, verification, measurements, raw: text };
}

export function agentPhaseSucceeded(handoff: Pick<ParsedHandoff, "status">): boolean {
  return handoff.status === "success" || handoff.status === "partial";
}

export function verificationIsStrongEnough(
  verification: HandoffVerification,
  opts: { requireTests: boolean },
): boolean {
  if (!opts.requireTests) return true;
  return (
    verification === "unit-test-verified" || verification === "live-ui-verified"
  );
}
