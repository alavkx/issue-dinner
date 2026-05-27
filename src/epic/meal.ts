import { loadMachineConfig, type MachineConfig } from "../config.js";
import { stateStoreForEpic } from "../paths.js";
import type { StateStore } from "../state/store.js";
import type { StackConfig } from "../stack/stack-config.js";
import { resolveStackForEpic } from "./stack.js";

export interface EpicMeal {
  epic: string;
  machine: MachineConfig;
  stack: StackConfig;
  store: StateStore;
  exclude: Set<string>;
}

export interface MealOptions {
  configPath?: string;
}

export function createMeal(epic: string, options: MealOptions = {}): EpicMeal {
  const machine = loadMachineConfig(options.configPath);
  const store = stateStoreForEpic(epic);
  store.setEpic(epic);

  return {
    epic,
    machine,
    stack: resolveStackForEpic(epic, machine),
    store,
    exclude: new Set<string>(),
  };
}

export function mergeExclude(
  meal: EpicMeal,
  csv: string | undefined,
): Set<string> {
  const merged = new Set(meal.exclude);
  if (!csv?.trim()) return merged;
  for (const key of csv.split(",")) {
    const trimmed = key.trim();
    if (trimmed) merged.add(trimmed);
  }
  return merged;
}
