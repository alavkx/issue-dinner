import { NodeContext } from "@effect/platform-node";
import * as Layer from "effect/Layer";
import { KitchenBuildPortLive } from "../self-heal/kitchen.js";
import { KitchenGitPortLive } from "../self-heal/contribute.js";

/** Base platform layer for CLI and integration tests (fs, path, subprocess, terminal). */
export const PlatformLive = Layer.mergeAll(
  NodeContext.layer,
  KitchenBuildPortLive,
  KitchenGitPortLive,
);
