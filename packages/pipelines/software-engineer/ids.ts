/**
 * Allowlisted handler ids and shared constants for the software-engineer pipeline.
 *
 * Kept in their own module so `cycle.ts` (which spawns the BUILD child) and
 * `handler.ts` (which registers both handlers) can share them without an import
 * cycle.
 */

import type { Capability } from "@vesper/core";

/** The lead handler that drives the full visualized, human-gated coding cycle. */
export const SOFTWARE_ENGINEER_HANDLER_ID = "software-engineer";

/** The spawn-only BUILD sub-agent (one per file-disjoint planned task). */
export const SWE_BUILD_HANDLER_ID = "swe:build";

/** `source` tag for every durable `events` audit row this pipeline writes. */
export const SWE_SOURCE = "software-engineer";

/**
 * Capabilities a BUILD sub-agent requires: invoke the CLI brain, read/write files
 * inside the worktree, and write its `runs` row. A strict subset of the lead's
 * grant (the two-sided sub-agent gate rejects anything broader).
 */
export const BUILD_CHILD_CAPABILITIES: readonly Capability[] = [
  "CLI_INVOKE",
  "FS_READ",
  "FS_WRITE",
  "WRITE_STORAGE",
];

/**
 * The lead task's capability superset. Because `grantedCapabilities()` unions only
 * task-input capabilities and the BUILD child is spawn-only (no task input), the
 * lead MUST declare the full set so the host ceiling covers the child.
 */
export const LEAD_CAPABILITIES: readonly Capability[] = [
  "CLI_INVOKE",
  "FS_READ",
  "FS_WRITE",
  "READ_STORAGE",
  "WRITE_STORAGE",
  "SPAWN_SUBAGENT",
  "PROCESS_RUN",
];

/** Default human-gate timeout (10 minutes) when neither the task cap nor a param sets one. */
export const DEFAULT_APPROVAL_TIMEOUT_MS = 600_000;
