export interface StackConfig {
  /** Shared epic branch stacked on graphiteTrunk. */
  base: string;
  /** Prefix for per-story branches: `{prefix}/{issue-key}`. */
  prefix: string;
  /** Graphite trunk branch name (usually main). */
  graphiteTrunk: string;
}
