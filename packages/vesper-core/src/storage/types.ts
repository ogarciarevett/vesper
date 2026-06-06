/**
 * Public types for the Vesper storage module.
 *
 * `Store` is synchronous because `bun:sqlite` is inherently synchronous — wrapping
 * operations in Promises would add allocation cost without benefit.
 */

import type { Capability } from "../capabilities/index.ts";

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

/** The latest context-window fill recorded for a run (from its most recent CLI completion). */
export interface RunContext {
  readonly usedTokens: number;
  readonly limit: number;
  readonly model: string | null;
}

/** A row from the `runs` table. */
export interface RunRow {
  readonly id: string;
  /** Unix timestamp in milliseconds. */
  readonly ts: number;
  readonly pipeline: string;
  readonly status: string;
  readonly summary: string;
  /** Parent run id when this run was spawned by another run; null for top-level runs. */
  readonly parentRunId: string | null;
  /** Unix timestamp (ms) the status was last changed (set by startRun/finishRun). */
  readonly statusUpdatedAt: number | null;
  /**
   * The latest context-window fill recorded for this run; null when no usage has been
   * recorded. Optional so partial RunRow literals (test doubles, signal snapshots) need
   * not specify it; `openStore`'s row mapper always populates it (value or null).
   */
  readonly context?: RunContext | null;
}

/** The kind of a {@link RunEventRow} — a step in the live per-run trace. */
export type RunEventKind = "step" | "log" | "progress" | "spawn" | "complete" | "usage";

/** A row from the `run_events` table — a single live-trace step for a run. */
export interface RunEventRow {
  readonly id: string;
  readonly runId: string;
  /** Unix timestamp in milliseconds. */
  readonly ts: number;
  readonly kind: RunEventKind;
  /** The deserialized payload object. */
  readonly payload: Record<string, unknown>;
}

/** Input for {@link Store.startRun} — opens a `running` run row. */
export interface StartRunInput {
  readonly pipeline: string;
  /** Parent run id when spawned by another run; null/omitted for top-level runs. */
  readonly parentRunId?: string | null;
  /** Pre-allocated run id; a fresh UUID is generated when omitted. */
  readonly runId?: string;
}

/** Input for {@link Store.finishRun} — transitions a run row to a terminal state. */
export interface FinishRunInput {
  readonly runId: string;
  readonly status: string;
  readonly summary: string;
}

/** Input for {@link Store.appendRunEvent}. */
export interface AppendRunEventInput {
  readonly runId: string;
  readonly kind: RunEventKind;
  readonly payload: Record<string, unknown>;
}

/** Input for {@link Store.recordRunContext}. */
export interface RecordRunContextInput {
  readonly runId: string;
  readonly usedTokens: number;
  readonly limit: number;
  readonly model: string | null;
}

/** Optional filters for {@link Store.listRunEvents}. */
export interface ListRunEventsOptions {
  readonly runId: string;
  /** Return only events strictly after this timestamp (ts > afterTs). */
  readonly afterTs?: number;
  /** Maximum number of rows to return (default: unlimited). */
  readonly limit?: number;
}

/** A node in the run hierarchy returned by {@link Store.runTree}. */
export interface RunTreeNode {
  readonly run: RunRow;
  readonly children: readonly RunTreeNode[];
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

/**
 * A row from the `task_grants` table — the per-task capability grant.
 *
 * The grant is the capabilities a specific task is actually allowed to use; it
 * is always a subset of the host union (the absolute ceiling). Keyed by
 * `(handler_id, content_hash)` so a regenerated/forge artifact (non-empty hash)
 * cannot silently reuse an old grant. Non-generated handlers use `content_hash = ""`.
 */
export interface TaskGrant {
  readonly handler_id: string;
  /** Content hash of a generated handler, or "" for built-in/CLI handlers. */
  readonly content_hash: string;
  readonly capabilities: readonly Capability[];
  /** Unix timestamp in milliseconds the grant was written. */
  readonly granted_at: number;
  /** Free-form provenance string (e.g. "register", "forge"). Audit metadata only. */
  readonly granted_by: string;
}

/** Input for {@link Store.upsertTaskGrant}. */
export interface UpsertTaskGrantInput {
  readonly handler_id: string;
  /** Defaults to "" (non-generated handler) when omitted. */
  readonly content_hash?: string;
  readonly capabilities: readonly Capability[];
  readonly granted_by: string;
  /** Defaults to `Date.now()` when omitted. */
  readonly granted_at?: number;
}

// ---------------------------------------------------------------------------
// Chat home (migration 007_chat_home)
// ---------------------------------------------------------------------------

/** A row from the `chat_sessions` table — one conversation thread. */
export interface ChatSessionRow {
  readonly id: string;
  /** Unix timestamp in milliseconds the session was created. */
  readonly ts: number;
  readonly title: string;
}

/** The role of a {@link ChatTurnRow}. */
export type ChatTurnRole = "user" | "assistant";

/**
 * A row from the `chat_turns` table — a single transcript bubble. An assistant
 * turn carries the `runId` of the router run that produced it, so the same row
 * renders both as a transcript bubble and as the root of the live activity tree.
 */
export interface ChatTurnRow {
  readonly id: string;
  readonly sessionId: string;
  /** Unix timestamp in milliseconds the turn was appended. */
  readonly ts: number;
  readonly role: ChatTurnRole;
  readonly text: string;
  /** The `runs` row id this assistant turn started, or null (user turns). */
  readonly runId: string | null;
}

/** A row from the `pipeline_templates` table — a pipeline's editable prompt + params. */
export interface PipelineTemplateRow {
  readonly handlerId: string;
  readonly prompt: string;
  /** The deserialized default-params object the router merges into spawn params. */
  readonly defaultParams: Record<string, unknown>;
  /** Unix timestamp in milliseconds the template was last written. */
  readonly updatedAt: number;
}

/** Input for {@link Store.createSession}. `id`/`ts` are generated when omitted. */
export interface CreateSessionInput {
  /** Pre-allocated session id (UUID); a fresh one is generated when omitted. */
  readonly id?: string;
  readonly title: string;
}

/** Input for {@link Store.appendTurn}. */
export interface AppendTurnInput {
  readonly sessionId: string;
  readonly role: ChatTurnRole;
  readonly text: string;
  /** The `runs` row this turn started (assistant turns); omitted/null for user turns. */
  readonly runId?: string | null;
}

/** Filters for {@link Store.listTurns}. */
export interface ListTurnsOptions {
  readonly sessionId: string;
  /** Return only turns strictly after this timestamp (ts > afterTs). */
  readonly afterTs?: number;
  /** Maximum number of rows to return (default: unlimited). */
  readonly limit?: number;
}

/** Input for {@link Store.upsertTemplate}. */
export interface UpsertTemplateInput {
  readonly handlerId: string;
  readonly prompt: string;
  /** Default-params object; serialized to JSON on write. */
  readonly defaultParams: Record<string, unknown>;
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
  /**
   * Filter by parent run id. THREE-WAY semantics:
   * - omitted (key absent) = no filter, all rows;
   * - `null` = only top-level rows (`parent_run_id IS NULL`);
   * - a string = only that parent's children.
   */
  readonly parentRunId?: string | null;
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
   *
   * Writes a single terminal row (no parent). Kept for back-compat with
   * non-scheduler callers; the scheduler path uses {@link Store.startRun} +
   * {@link Store.finishRun} so a run is visible while still in flight.
   */
  recordRun(input: RecordRunInput): string;

  /**
   * Open a `running` run row up front and return its id (generated when
   * `input.runId` is omitted). `status_updated_at` is set to the insert time.
   */
  startRun(input: StartRunInput): string;

  /**
   * Transition an existing run row to a terminal `status`/`summary`, bumping
   * `status_updated_at`. Throws {@link StorageError} (`query_failed`) when no
   * row matches `input.runId`.
   */
  finishRun(input: FinishRunInput): void;

  /**
   * Record (or overwrite) the latest context-window usage for a run. Updates the
   * three `ctx_*` columns on the `runs` row so the value is available without
   * scanning `run_events`. No-op when `input.runId` does not exist (best-effort —
   * mirrors the non-destructive design decision in the spec).
   */
  recordRunContext(input: RecordRunContextInput): void;

  /**
   * Append a live-trace event for a run and return its generated id.
   */
  appendRunEvent(input: AppendRunEventInput): string;

  /**
   * List a run's trace events oldest-first, optionally filtered by `afterTs`
   * (strictly greater) and capped by `limit`.
   */
  listRunEvents(options: ListRunEventsOptions): RunEventRow[];

  /**
   * Assemble the run hierarchy rooted at `rootRunId` (the run and its children).
   * Returns null when `rootRunId` does not exist. Cycle-safe.
   */
  runTree(rootRunId: string): RunTreeNode | null;

  /**
   * List runs, optionally filtered. Results are ordered oldest-first.
   */
  listRuns(options?: ListRunsOptions): RunRow[];

  /**
   * Insert or update the per-task capability grant keyed by
   * `(handler_id, content_hash)`. Re-running with the same key refreshes the
   * capabilities, `granted_at`, and `granted_by` (ON CONFLICT upsert).
   */
  upsertTaskGrant(input: UpsertTaskGrantInput): void;

  /**
   * Return the per-task grant for `handlerId`, or null if none exists.
   * `contentHash` defaults to "" (the non-generated-handler key).
   */
  getTaskGrant(handlerId: string, contentHash?: string): TaskGrant | null;

  // -------------------------------------------------------------------------
  // Chat home (migration 007_chat_home)
  // -------------------------------------------------------------------------

  /** Create a chat session and return its generated (or supplied) id. */
  createSession(input: CreateSessionInput): string;

  /** Append a transcript turn and return its generated id. */
  appendTurn(input: AppendTurnInput): string;

  /** List chat sessions newest-first (most recent activity at the top). */
  listSessions(): ChatSessionRow[];

  /** List a session's turns oldest-first, optionally filtered by `afterTs`/`limit`. */
  listTurns(options: ListTurnsOptions): ChatTurnRow[];

  /** Return the editable template for `handlerId`, or null if none was saved yet. */
  getTemplate(handlerId: string): PipelineTemplateRow | null;

  /** Insert or update a pipeline's editable template (prompt + default params). */
  upsertTemplate(input: UpsertTemplateInput): void;

  /**
   * Number of indexed RAG documents (`rag_documents` rows). 0 until the embedding model
   * + indexer land (semantic memory is scaffolded but disabled — see specs/rag-memory.md).
   * Backs the Memory surface's status.
   */
  ragDocumentCount(): number;

  /**
   * Close the underlying database connection. After this call the store must not be used.
   */
  close(): void;
}
