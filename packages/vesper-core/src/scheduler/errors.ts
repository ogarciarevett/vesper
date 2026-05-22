import { VesperError } from "../errors.ts";

/** Why a scheduler operation failed. */
export type SchedulerErrorReason =
  | "unknown_task"
  | "duplicate_task"
  | "invalid_cron"
  | "unknown_handler";

/** Raised by every scheduler operation, discriminated by {@link SchedulerError.reason}. */
export class SchedulerError extends VesperError {
  readonly reason: SchedulerErrorReason;

  constructor(reason: SchedulerErrorReason, message: string, options?: ErrorOptions) {
    super("scheduler", message, options);
    this.reason = reason;
  }
}
