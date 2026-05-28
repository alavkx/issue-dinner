import { isSdkCanceledError } from "../agent/sdk-errors.js";

let serveShutdownHandler: (() => void) | undefined;

/** Register a handler invoked when the process must exit after an SDK abort during serve. */
export function setServeShutdownHandler(handler: (() => void) | undefined): void {
  serveShutdownHandler = handler;
}

function handleOrRethrow(kind: string, err: unknown): boolean {
  if (!isSdkCanceledError(err)) {
    return false;
  }
  console.error(
    `\n⚠ ${kind}: Cursor agent connection canceled (stall timeout). Saving dinner state…`,
  );
  try {
    serveShutdownHandler?.();
  } catch (handlerErr) {
    console.error(
      `warn: shutdown handler failed: ${
        handlerErr instanceof Error ? handlerErr.message : String(handlerErr)
      }`,
    );
  }
  process.exitCode = 2;
  return true;
}

let installed = false;

/** Catch SDK stall-abort errors that escape async try/catch via timers. */
export function installProcessGuards(): void {
  if (installed) return;
  installed = true;

  process.on("unhandledRejection", (reason) => {
    if (handleOrRethrow("Unhandled agent rejection", reason)) {
      return;
    }
    console.error("Unhandled rejection:", reason);
    process.exitCode = 1;
  });

  process.on("uncaughtException", (err) => {
    if (handleOrRethrow("Uncaught agent error", err)) {
      return;
    }
    console.error(err);
    process.exit(1);
  });
}
