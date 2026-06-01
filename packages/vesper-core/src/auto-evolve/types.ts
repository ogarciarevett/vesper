/**
 * Public types for the auto-evolve core module.
 *
 * Auto-evolve gathers runtime-health signals (recent runs, dead-lettered tasks,
 * per-task last errors), drives the user's CLI to reflect on them, and writes
 * proposals to the `events` table. These types describe the read-only signal
 * snapshot and the typed reflection artifact — both are pure data (no I/O).
 */

import type { FailedTask } from "../scheduler/types.ts";
import type { RunRow } from "../storage/types.ts";

/** Roll-up of run outcomes for a single pipeline within the gather window. */
export interface PipelineRunRollup {
  readonly pipeline: string;
  /** Total runs seen in the window. */
  readonly total: number;
  /** Runs with status `"error"`. */
  readonly errors: number;
}

/** A scheduled task's most recent error, surfaced when `last_error` is non-null. */
export interface TaskError {
  readonly taskId: string;
  readonly lastError: string;
  readonly attemptCount: number;
}

/**
 * A frozen, read-only snapshot of runtime-health signals over a time window.
 *
 * Assembled by {@link import("./gather.ts").gatherSignals} from the store +
 * task-persistence reads. The handler reflects on `digest` ONLY — the raw rows are
 * never interpolated verbatim into the reflection prompt (untrusted-data discipline).
 */
export interface EvolveSignals {
  /** Inclusive lower bound (unix ms) of the window these signals cover. */
  readonly sinceMs: number;
  /** Recent runs in the window (oldest-first), capped by the gather limit. */
  readonly runs: readonly RunRow[];
  /** Per-pipeline error roll-up over the windowed runs. */
  readonly rollups: readonly PipelineRunRollup[];
  /** Dead-lettered tasks whose `run_at` falls in the window. */
  readonly failedTasks: readonly FailedTask[];
  /** Per-task last-error rows for enabled tasks with a non-null `last_error`. */
  readonly taskErrors: readonly TaskError[];
  /** Deterministic, length-capped human-readable summary — the only thing put in the prompt. */
  readonly digest: string;
}

/** A new-skill recommendation parsed from a reflection report. */
export interface SkillProposal {
  readonly name: string;
  readonly reason: string;
}

/** A concrete, reviewable fix proposal for a distinct error signature. */
export interface FixProposal {
  readonly signature: string;
  readonly rootCause: string;
  readonly proposedFix: string;
}

/** The typed artifact parsed from the reflection model's fenced-JSON reply. */
export interface EvolveReport {
  readonly summary: string;
  readonly skillProposals: readonly SkillProposal[];
  readonly fixProposals: readonly FixProposal[];
}
