/** Normalize Cursor SDK / Connect-RPC failures for logging and recovery. */

export function isSdkCanceledError(err: unknown): boolean {
  if (!err || typeof err !== "object") {
    const text = String(err);
    return /abort|canceled|cancelled/i.test(text);
  }

  const rec = err as {
    name?: string;
    code?: number;
    message?: string;
    rawMessage?: string;
  };

  if (rec.name === "ConnectError" && rec.code === 1) {
    return true;
  }

  const text = [rec.message, rec.rawMessage].filter(Boolean).join(" ");
  return /abort|canceled|cancelled|stall/i.test(text);
}

export function formatAgentError(err: unknown): string {
  if (isSdkCanceledError(err)) {
    return "Cursor agent connection canceled (stall timeout or abort)";
  }
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}
