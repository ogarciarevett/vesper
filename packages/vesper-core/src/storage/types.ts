/**
 * Public types for the Vesper storage module.
 *
 * `Store` is synchronous because `bun:sqlite` is inherently synchronous — wrapping
 * operations in Promises would add allocation cost without benefit.
 */

/** A row from the `events` table. */
export interface EventRow {
  readonly id: string;
  /** Unix timestamp in milliseconds. */
  readonly ts: number;
  readonly source: string;
  readonly kind: string;
  /** The deserialized payload object. */
  readonly payload: Record<string, unknown>;
}

/** A row from the `runs` table. */
export interface RunRow {
  readonly id: string;
  /** Unix timestamp in milliseconds. */
  readonly ts: number;
  readonly pipeline: string;
  readonly status: string;
  readonly summary: string;
}

/** Input for {@link Store.appendEvent}. */
export interface AppendEventInput {
  readonly source: string;
  readonly kind: string;
  readonly payload: Record<string, unknown>;
}

/** Input for {@link Store.recordRun}. */
export interface RecordRunInput {
  readonly pipeline: string;
  readonly status: string;
  readonly summary: string;
}

/** Optional filters for {@link Store.listEvents}. */
export interface ListEventsOptions {
  /** Return only events with this source. */
  readonly source?: string;
  /** Return only events with this kind. */
  readonly kind?: string;
  /** Maximum number of rows to return (default: unlimited). */
  readonly limit?: number;
}

/** Optional filters for {@link Store.listRuns}. */
export interface ListRunsOptions {
  /** Return only runs with this pipeline name. */
  readonly pipeline?: string;
  /** Return only runs with this status. */
  readonly status?: string;
  /** Maximum number of rows to return (default: unlimited). */
  readonly limit?: number;
}

/**
 * Synchronous interface to the Vesper local store.
 * All operations throw {@link StorageError} on failure.
 */
export interface Store {
  /**
   * Apply any pending forward migrations. Safe to call repeatedly — already-applied
   * migrations are skipped (idempotent).
   */
  migrate(): void;

  /**
   * Append an event record and return its generated id.
   */
  appendEvent(input: AppendEventInput): string;

  /**
   * List events, optionally filtered. Results are ordered oldest-first.
   */
  listEvents(options?: ListEventsOptions): EventRow[];

  /**
   * Record a pipeline run and return its generated id.
   */
  recordRun(input: RecordRunInput): string;

  /**
   * List runs, optionally filtered. Results are ordered oldest-first.
   */
  listRuns(options?: ListRunsOptions): RunRow[];

  /**
   * Close the underlying database connection. After this call the store must not be used.
   */
  close(): void;
}
