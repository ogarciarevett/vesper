import { VesperError } from "../errors.ts";

/** Why a storage operation failed. */
export type StorageErrorReason =
  | "open_failed"
  | "migration_failed"
  | "query_failed"
  /** Semantic memory (RAG) is not enabled on this host — no embedding model / sqlite-vec
   * extension is wired. Callers narrow on this to degrade gracefully instead of crashing. */
  | "rag_unavailable";

/** Raised by every {@link Store} operation, discriminated by {@link StorageError.reason}. */
export class StorageError extends VesperError {
  readonly reason: StorageErrorReason;

  constructor(reason: StorageErrorReason, message: string, options?: ErrorOptions) {
    super("storage", message, options);
    this.reason = reason;
  }
}
