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
}
