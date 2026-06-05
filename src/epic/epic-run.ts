import * as FileSystem from "@effect/platform/FileSystem";
import * as Effect from "effect/Effect";
import { loadMachineConfig, type MachineConfig } from "../config.js";
import { ConfigNotFound } from "../effect/errors.js";
import type { BlockerPolicy } from "../state/store.js";
import type { StackConfig } from "../stack/stack-config.js";
import { resolveStackForEpic } from "./stack.js";

export interface EpicRun {
  epic: string;
  machine: MachineConfig;
  stack: StackConfig;
  blockerPolicy: BlockerPolicy;
  exclude: Set<string>;
}

export interface EpicRunOptions {
  configPath?: string;
}

export const createEpicRun = (
  epic: string,
  options: EpicRunOptions = {},
): Effect.Effect<EpicRun, ConfigNotFound, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const machine = yield* loadMachineConfig(options.configPath);
    return {
      epic,
      machine,
      stack: resolveStackForEpic(epic, machine),
      blockerPolicy: machine.blockerPolicy as BlockerPolicy,
      exclude: new Set<string>(),
    };
  });

export function mergeExclude(
  run: EpicRun,
  csv: string | undefined,
): Set<string> {
  const merged = new Set(run.exclude);
  if (!csv?.trim()) return merged;
  for (const key of csv.split(",")) {
    const trimmed = key.trim();
    if (trimmed) merged.add(trimmed);
  }
  return merged;
}
