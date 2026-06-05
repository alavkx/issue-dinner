import { NodeContext } from "@effect/platform-node";
import * as Layer from "effect/Layer";
import { SelfHealBuildPortLive } from "../self-heal/heal-build.js";
import { SelfHealGitPortLive } from "../self-heal/contribute.js";

/** Base platform layer for CLI and integration tests (fs, path, subprocess, terminal). */
export const PlatformLive = Layer.mergeAll(
  NodeContext.layer,
  SelfHealBuildPortLive,
  SelfHealGitPortLive,
);
