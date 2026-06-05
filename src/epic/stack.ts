import type { MachineConfig } from "../config.js";
import type { StackConfig } from "../stack/stack-config.js";

export function resolveStackAuthor(machine: StackMachineInput): string {
  const author =
    machine.stackAuthor?.trim() ||
    process.env.ISSUE_DINNER_STACK_AUTHOR?.trim();
  if (!author) {
    throw new Error(
      "Stack author required: set ISSUE_DINNER_STACK_AUTHOR or stackAuthor in ~/.config/issue-dinner/config.json",
    );
  }
  return author;
}

export interface StackMachineInput {
  stackAuthor?: string;
  stackBaseOverride?: string;
  graphiteTrunk?: string;
}

export function resolveStackForEpic(
  epicKey: string,
  machine: StackMachineInput,
): StackConfig {
  const author = resolveStackAuthor(machine);
  const epic = epicKey.toLowerCase();
  const prefix = `${author}/${epic}`;
  const base =
    machine.stackBaseOverride?.trim() ?? `${author}/${epic}-trunk`;
  return {
    prefix,
    base,
    graphiteTrunk: machine.graphiteTrunk ?? "main",
  };
}
