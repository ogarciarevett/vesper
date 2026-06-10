/**
 * Autonomous-loop types (`specs/autonomous-loop.md`, DEV-113).
 *
 * A loop is an LLM-authored self-prompting cycle: the human sets an objective,
 * and per iteration the model AUTHORs the next prompt, EXECUTEs it, and a CRITIC
 * judges the result against the objective. All three roles run over
 * `PipelineContext.complete` (the user's CLI — Hard rule 12), so v1 is a pure
 * *reasoning* loop: text in, text out, no tools, no file writes, no network.
 */

import type { AppendEventInput } from "../storage/types.ts";

/** The human-set goal a loop drives toward — the ONLY required human input. */
export interface LoopObjective {
  readonly goal: string;
  /** Optional explicit definition of done, handed to AUTHOR and CRITIC verbatim. */
  readonly successCriteria?: string;
}

/** Per-role CLI overrides; an omitted role uses the run-override/configured default. */
export interface LoopRoles {
  readonly authorCli?: string;
  readonly executeCli?: string;
  readonly criticCli?: string;
  /**
   * Model for the loop's MASTERMIND roles (AUTHOR + CRITIC) — the
   * orchestrator-by-default pattern (specs/pipeline-editor.md): judgment runs on
   * a frontier model while EXECUTE stays on the run/default routing.
   */
  readonly orchestratorModel?: string;
}

/** Hard bounds — a runaway self-prompting loop is the headline failure mode. */
export interface LoopBounds {
  /** Hard iteration cap (default {@link LOOP_DEFAULT_MAX_ITERATIONS}, ceiling {@link LOOP_MAX_ITERATIONS_CEILING}). */
  readonly maxIterations: number;
  /** Stop after this many consecutive iterations without critic progress (default {@link LOOP_DEFAULT_MAX_NO_PROGRESS}). */
  readonly maxNoProgress?: number;
  /** Wall-clock budget (ms) across the whole loop. No budget when omitted. */
  readonly maxTotalMs?: number;
}

/** Everything {@link import("./engine.ts").runLoop} needs to run one loop. */
export interface LoopSpec {
  readonly objective: LoopObjective;
  readonly roles?: LoopRoles;
  readonly bounds: LoopBounds;
}

/** Terminal state of a finished loop. */
export type LoopStatus = "succeeded" | "exhausted" | "stalled" | "aborted";

/** The critic's judgment of one iteration, parsed FAIL-CLOSED from its reply. */
export interface LoopVerdict {
  readonly done: boolean;
  /** Progress toward the objective, 0-100. */
  readonly progress: number;
  readonly feedback: string;
}

/** One completed AUTHOR -> EXECUTE -> CRITIC turn. */
export interface LoopIteration {
  /** 1-based iteration index. */
  readonly index: number;
  readonly authoredPrompt: string;
  readonly executionSummary: string;
  readonly verdict: LoopVerdict;
}

/** The finished loop: how it ended, every iteration, and the last execution output. */
export interface LoopResult {
  readonly status: LoopStatus;
  readonly iterations: readonly LoopIteration[];
  readonly finalOutput: string;
}

/**
 * Injected seams for {@link import("./engine.ts").runLoop}. `appendEvent` writes the
 * per-iteration audit row to the `events` table at metadata granularity (the host
 * pipeline injects a store-backed writer; unit tests inject a recorder). `now` is the
 * injectable clock for the wall-clock budget (the scheduler's existing pattern).
 */
export interface LoopDeps {
  readonly appendEvent?: (input: AppendEventInput) => string;
  readonly now?: () => number;
}

/** Default hard iteration cap. */
export const LOOP_DEFAULT_MAX_ITERATIONS = 8;
/** Absolute iteration ceiling — `maxIterations` above this is clamped down. */
export const LOOP_MAX_ITERATIONS_CEILING = 50;
/** Default consecutive no-progress iterations before the loop stalls out. */
export const LOOP_DEFAULT_MAX_NO_PROGRESS = 2;
