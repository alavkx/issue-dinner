/** ANSI styling — disabled when NO_COLOR is set or stdout is not a TTY. */

export function useColor(): boolean {
  if (process.env.NO_COLOR !== undefined) return false;
  return Boolean(process.stdout.isTTY);
}

const ESC = "\u001b[";

export function wrap(code: string, text: string): string {
  if (!useColor()) return text;
  return `${ESC}${code}m${text}${ESC}0m`;
}

export const fg = {
  bold: (t: string) => wrap("1", t),
  dim: (t: string) => wrap("2", t),
  red: (t: string) => wrap("31", t),
  green: (t: string) => wrap("32", t),
  yellow: (t: string) => wrap("33", t),
  blue: (t: string) => wrap("34", t),
  magenta: (t: string) => wrap("35", t),
  cyan: (t: string) => wrap("36", t),
  gray: (t: string) => wrap("90", t),
};

export function statusColor(
  status: string,
): (t: string) => string {
  switch (status) {
    case "verified":
    case "finished":
      return fg.green;
    case "running":
      return fg.cyan;
    case "agent_complete":
      return fg.yellow;
    case "error":
    case "cancelled":
      return fg.red;
    case "skipped":
      return fg.gray;
    default:
      return fg.dim;
  }
}

export function statusBadge(status: string): string {
  const paint = statusColor(status);
  return paint(` ${status.padEnd(14)} `);
}
