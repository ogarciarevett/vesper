import type { Capability } from "../capabilities/index.ts";

/** The kind of trigger that activates a scheduled task. */
export type TaskKind = "cron" | "event" | "manual";

/**
 * A persisted scheduled task record.
 *
 * - `kind = "cron"`: `schedule_expr` is a standard 5-field cron expression.
 * - `kind = "event"`: `schedule_expr` is the event topic to subscribe to.
 * - `kind = "manual"`: `schedule_expr` is `""` (no automatic trigger).
 */
export interface ScheduledTask {
  readonly id: string;
  readonly kind: TaskKind;
  /** Cron expression, event topic, or empty string for manual tasks. */
  readonly schedule_expr: string;
  /** String ID referencing the registered {@link TaskHandler}. */
  readonly handler_id: string;
  readonly enabled: boolean;
  /** Unix timestamp in milliseconds of the most recent run, or null if never run. */
  readonly last_run_at: number | null;
  /** Error message from the most recent run, or null if the last run succeeded. */
  readonly last_error: string | null;

  // ---------------------------------------------------------------------------
  // Guardrail caps (optional — null/undefined means no cap)
  // ---------------------------------------------------------------------------

  /** Maximum number of scheduled (cron/event) runs allowed per calendar day. */
  readonly max_runs_per_day: number | null;
  /** Maximum number of concurrent in-flight invocations for this task. */
  readonly max_concurrent: number | null;
  /** Maximum wall-clock duration (ms) before a run is aborted and treated as a failure. */
  readonly max_duration_ms: number | null;

  // ---------------------------------------------------------------------------
  // Guardrail bookkeeping (maintained by the scheduler)
  // ---------------------------------------------------------------------------

  /** Number of scheduled runs completed today (resets when `runs_today_date` changes). */
  readonly runs_today: number;
  /** The calendar date (ISO, YYYY-MM-DD) for which `runs_today` was last reset. */
  readonly runs_today_date: string | null;
  /** Number of consecutive failures since the last successful run. */
  readonly attempt_count: number;
  /** Unix timestamp (ms) before which the task must not be retried. */
  readonly next_attempt_at: number | null;

  // ---------------------------------------------------------------------------
  // Capability enforcement (DEV-109)
  // ---------------------------------------------------------------------------

  /** Capabilities this task requires from the host. Empty array means no restrictions. */
  readonly required_capabilities: readonly Capability[];
}

/** Context provided to a handler when a task is invoked. */
export interface TaskContext {
  readonly task: ScheduledTask;
  readonly now: Date;
}

/** A function invoked when a task is triggered. */
export type TaskHandler = (ctx: TaskContext) => Promise<void> | void;

/** Input for registering a new scheduled task. */
export interface RegisterTaskInput {
  readonly id: string;
  readonly kind: TaskKind;
  /** Cron expression (for cron), event topic (for event), or "" (for manual). */
  readonly schedule_expr: string;
  /** ID of the handler to invoke, must be registered in the {@link HandlerRegistry}. */
  readonly handler_id: string;
  /** Whether the task starts enabled. Defaults to true. */
  readonly enabled?: boolean;

  // ---------------------------------------------------------------------------
  // Optional guardrail caps
  // ---------------------------------------------------------------------------

  /** Maximum scheduled runs per calendar day. No limit if omitted. */
  readonly max_runs_per_day?: number;
  /** Maximum concurrent in-flight invocations. No limit if omitted. */
  readonly max_concurrent?: number;
  /** Maximum run duration in ms. No timeout if omitted. */
  readonly max_duration_ms?: number;
  /**
   * Capabilities this task requires from the host.
   * Defaults to [] (no capabilities needed).
   * If any required capability is not in the host's granted list, the task is refused.
   */
  readonly required_capabilities?: readonly Capability[];
}

/** A dead-lettered task entry, written when a task exceeds the max retry attempts. */
export interface FailedTask {
  readonly id: string;
  readonly task_id: string;
  /** Unix timestamp (ms) of the run that caused the dead-letter. */
  readonly run_at: number;
  readonly error: string;
  readonly attempt_count: number;
}
