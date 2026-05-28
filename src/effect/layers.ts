import { NodeContext } from "@effect/platform-node";

/** Base platform layer for CLI and integration tests (fs, path, subprocess, terminal). */
export const PlatformLive = NodeContext.layer;
