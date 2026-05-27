const EPIC_KEY_RE = /^[A-Z][A-Z0-9]+-\d+$/;

export function isEpicKey(value: string): boolean {
  return EPIC_KEY_RE.test(value);
}

export type ParsedArgv =
  | { mode: "meal"; epic: string; rest: string[]; configPath?: string }
  | { mode: "global"; rest: string[]; configPath?: string };

const GLOBAL_COMMANDS = new Set(["show", "verify", "help", "--help", "-h"]);

const MEAL_COMMANDS = new Set([
  "list",
  "status",
  "prep",
  "serve",
  "launch",
  "cook",
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
      (!MEAL_COMMANDS.has(tail[0]!) && tail[0]?.startsWith("-"));
    const commandRest = needsDefaultLaunch ? ["launch", ...tail] : tail;
    return { mode: "meal", epic: first, rest: commandRest, configPath };
  }

  return { mode: "global", rest, configPath };
}

export function assertMealCommand(command: string | undefined): string {
  if (!command || !MEAL_COMMANDS.has(command)) {
    throw new Error(
      `Unknown meal command "${command ?? ""}". Use: list, status, prep, serve, launch, cook`,
    );
  }
  return command;
}
