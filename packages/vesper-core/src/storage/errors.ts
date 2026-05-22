import { VesperError } from "../errors.ts";

/** Why a storage operation failed. */
export type StorageErrorReason = "open_failed" | "migration_failed" | "query_failed";

/** Raised by every {@link Store} operation, discriminated by {@link StorageError.reason}. */
export class StorageError extends VesperError {
  readonly reason: StorageErrorReason;

  constructor(reason: StorageErrorReason, message: string, options?: ErrorOptions) {
    super("storage", message, options);
    this.reason = reason;
  }
}
