const EPIC_KEY_RE = /^[A-Z][A-Z0-9]+-\d+$/;

export function isEpicKey(value: string): boolean {
  return EPIC_KEY_RE.test(value);
}

export type ParsedArgv =
  | { mode: "epic"; epic: string; rest: string[]; configPath?: string }
  | { mode: "global"; rest: string[]; configPath?: string };

const GLOBAL_COMMANDS = new Set(["show", "verify", "heal", "help", "--help", "-h"]);

const EPIC_COMMANDS = new Set([
  "list",
  "status",
  "prep",
  "serve",
  "launch",
  "run",
]);

export function stripGlobalFlags(argv: string[]): {
  rest: string[];
  configPath?: string;
} {
  const rest: string[] = [];
  let configPath: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "-c" || arg === "--config") {
      configPath = argv[++i];
      continue;
    }
    rest.push(arg);
  }
  return { rest, configPath };
}

export function parseTopLevelArgv(argv: string[]): ParsedArgv {
  const { rest, configPath } = stripGlobalFlags(argv);
  const first = rest[0];

  if (first && isEpicKey(first)) {
    const tail = rest.slice(1);
    const needsDefaultLaunch =
      tail.length === 0 ||
      (!EPIC_COMMANDS.has(tail[0]!) && tail[0]?.startsWith("-"));
    const commandRest = needsDefaultLaunch ? ["launch", ...tail] : tail;
    return { mode: "epic", epic: first, rest: commandRest, configPath };
  }

  return { mode: "global", rest, configPath };
}

export function assertEpicCommand(command: string | undefined): string {
  if (!command || !EPIC_COMMANDS.has(command)) {
    throw new Error(
      `Unknown epic command "${command ?? ""}". Use: list, status, prep, serve, launch, run`,
    );
  }
  return command;
}
