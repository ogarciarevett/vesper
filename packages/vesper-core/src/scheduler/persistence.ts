/**
 * CRUD operations for the `scheduled_tasks` and `failed_tasks` tables.
 *
 * Uses parameterized queries exclusively (no string interpolation).
 * Raw rows are narrowed via typed assert helpers — no `any`.
 */

import type { Database } from "bun:sqlite";
import type { Capability } from "../capabilities/index.ts";
import { isCapability } from "../capabilities/index.ts";
import { SchedulerError } from "./errors.ts";
import type { FailedTask, ScheduledTask, TaskKind } from "./types.ts";

// ---------------------------------------------------------------------------
// Raw row shape — all columns come back as unknown from bun:sqlite.
// ---------------------------------------------------------------------------

interface RawTaskRow {
  id: unknown;
  kind: unknown;
  schedule_expr: unknown;
  handler_id: unknown;
  enabled: unknown;
  last_run_at: unknown;
  last_error: unknown;
  max_runs_per_day: unknown;
  max_concurrent: unknown;
  max_duration_ms: unknown;
  runs_today: unknown;
  runs_today_date: unknown;
  attempt_count: unknown;
  next_attempt_at: unknown;
  required_capabilities: unknown;
}

interface RawFailedTaskRow {
  id: unknown;
  task_id: unknown;
  run_at: unknown;
  error: unknown;
  attempt_count: unknown;
}

// ---------------------------------------------------------------------------
// Narrowing helpers
// ---------------------------------------------------------------------------

function assertString(value: unknown, column: string): string {
  if (typeof value !== "string") {
    throw new SchedulerError(
      "unknown_task",
      `expected string for column "${column}", got ${typeof value}`,
    );
  }
  return value;
}

function assertNumber(value: unknown, column: string): number {
  if (typeof value !== "number") {
    throw new SchedulerError(
      "unknown_task",
      `expected number for column "${column}", got ${typeof value}`,
    );
  }
  return value;
}

function assertTaskKind(value: string): TaskKind {
  if (value === "cron" || value === "event" || value === "manual") {
    return value;
  }
  throw new SchedulerError("unknown_task", `unrecognised task kind "${value}"`);
}

/**
 * Parse the required_capabilities JSON text column into a `Capability[]`.
 * Silently discards unrecognised strings (forward-compat / corruption guard).
 */
function parseRequiredCapabilities(raw: unknown): readonly Capability[] {
  if (typeof raw !== "string") {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) {
    return [];
  }
  return parsed.filter(isCapability);
}

function toTask(raw: RawTaskRow): ScheduledTask {
  const enabledRaw = assertNumber(raw.enabled, "enabled");

  // Nullable columns — SQLite returns null for NULL.
  let last_run_at: number | null = null;
  if (raw.last_run_at !== null) {
    last_run_at = assertNumber(raw.last_run_at, "last_run_at");
  }

  let last_error: string | null = null;
  if (raw.last_error !== null) {
    last_error = assertString(raw.last_error, "last_error");
  }

  let max_runs_per_day: number | null = null;
  if (raw.max_runs_per_day !== null && raw.max_runs_per_day !== undefined) {
    max_runs_per_day = assertNumber(raw.max_runs_per_day, "max_runs_per_day");
  }

  let max_concurrent: number | null = null;
  if (raw.max_concurrent !== null && raw.max_concurrent !== undefined) {
    max_concurrent = assertNumber(raw.max_concurrent, "max_concurrent");
  }

  let max_duration_ms: number | null = null;
  if (raw.max_duration_ms !== null && raw.max_duration_ms !== undefined) {
    max_duration_ms = assertNumber(raw.max_duration_ms, "max_duration_ms");
  }

  let runs_today_date: string | null = null;
  if (raw.runs_today_date !== null && raw.runs_today_date !== undefined) {
    runs_today_date = assertString(raw.runs_today_date, "runs_today_date");
  }

  let next_attempt_at: number | null = null;
  if (raw.next_attempt_at !== null && raw.next_attempt_at !== undefined) {
    next_attempt_at = assertNumber(raw.next_attempt_at, "next_attempt_at");
  }

  // runs_today and attempt_count always have NOT NULL DEFAULT 0 in schema.
  const runs_today_raw = raw.runs_today ?? 0;
  const attempt_count_raw = raw.attempt_count ?? 0;

  return {
    id: assertString(raw.id, "id"),
    kind: assertTaskKind(assertString(raw.kind, "kind")),
    schedule_expr: assertString(raw.schedule_expr, "schedule_expr"),
    handler_id: assertString(raw.handler_id, "handler_id"),
    enabled: enabledRaw !== 0,
    last_run_at,
    last_error,
    max_runs_per_day,
    max_concurrent,
    max_duration_ms,
    runs_today: typeof runs_today_raw === "number" ? runs_today_raw : 0,
    runs_today_date,
    attempt_count: typeof attempt_count_raw === "number" ? attempt_count_raw : 0,
    next_attempt_at,
    required_capabilities: parseRequiredCapabilities(raw.required_capabilities),
  };
}

function toFailedTask(raw: RawFailedTaskRow): FailedTask {
  return {
    id: assertString(raw.id, "id"),
    task_id: assertString(raw.task_id, "task_id"),
    run_at: assertNumber(raw.run_at, "run_at"),
    error: assertString(raw.error, "error"),
    attempt_count: assertNumber(raw.attempt_count, "attempt_count"),
  };
}

const SELECT_COLUMNS =
  "id, kind, schedule_expr, handler_id, enabled, last_run_at, last_error, " +
  "max_runs_per_day, max_concurrent, max_duration_ms, " +
  "runs_today, runs_today_date, attempt_count, next_attempt_at, required_capabilities";

// ---------------------------------------------------------------------------
// TaskPersistence class
// ---------------------------------------------------------------------------

/**
 * Synchronous CRUD layer for `scheduled_tasks` and `failed_tasks`, injecting the
 * `Database` instance so callers control lifecycle and can use in-memory DBs in tests.
 */
export class TaskPersistence {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  /** Insert a new task row. The caller must guarantee `id` is unique. */
  insert(task: ScheduledTask): void {
    this.#db
      .query<
        void,
        [
          string,
          string,
          string,
          string,
          number,
          number | null,
          string | null,
          number | null,
          number | null,
          number | null,
          number,
          string | null,
          number,
          number | null,
          string,
        ]
      >(
        `INSERT INTO scheduled_tasks
           (id, kind, schedule_expr, handler_id, enabled, last_run_at, last_error,
            max_runs_per_day, max_concurrent, max_duration_ms,
            runs_today, runs_today_date, attempt_count, next_attempt_at,
            required_capabilities)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        task.id,
        task.kind,
        task.schedule_expr,
        task.handler_id,
        task.enabled ? 1 : 0,
        task.last_run_at,
        task.last_error,
        task.max_runs_per_day,
        task.max_concurrent,
        task.max_duration_ms,
        task.runs_today,
        task.runs_today_date,
        task.attempt_count,
        task.next_attempt_at,
        JSON.stringify(task.required_capabilities),
      );
  }

  /** Return a single task by id, or null if not found. */
  get(id: string): ScheduledTask | null {
    const row = this.#db
      .query<RawTaskRow, [string]>(`SELECT ${SELECT_COLUMNS} FROM scheduled_tasks WHERE id = ?`)
      .get(id);
    return row !== null ? toTask(row) : null;
  }

  /** Return all tasks, ordered by rowid (insertion order). */
  list(): ScheduledTask[] {
    const rows = this.#db
      .query<RawTaskRow, []>(`SELECT ${SELECT_COLUMNS} FROM scheduled_tasks ORDER BY rowid ASC`)
      .all();
    return rows.map(toTask);
  }

  /**
   * Update `last_run_at` and `last_error` for a task after execution.
   *
   * `ts` is the Unix timestamp in milliseconds. `error` is null on success.
   */
  updateLastRun(id: string, ts: number, error: string | null): void {
    this.#db
      .query<void, [number, string | null, string]>(
        "UPDATE scheduled_tasks SET last_run_at = ?, last_error = ? WHERE id = ?",
      )
      .run(ts, error, id);
  }

  /** Enable or disable a task by id. */
  setEnabled(id: string, enabled: boolean): void {
    this.#db
      .query<void, [number, string]>("UPDATE scheduled_tasks SET enabled = ? WHERE id = ?")
      .run(enabled ? 1 : 0, id);
  }

  /** Delete a task row. No-op if `id` does not exist. */
  delete(id: string): void {
    this.#db.query<void, [string]>("DELETE FROM scheduled_tasks WHERE id = ?").run(id);
  }

  /**
   * Update guardrail bookkeeping fields for a task.
   *
   * Used after scheduled runs to maintain daily counter, backoff state, and
   * concurrent tracking (concurrent is in-memory only; this persists the rest).
   */
  updateGuardrails(
    id: string,
    fields: {
      readonly runs_today?: number;
      readonly runs_today_date?: string | null;
      readonly attempt_count?: number;
      readonly next_attempt_at?: number | null;
      readonly enabled?: boolean;
      readonly last_error?: string | null;
    },
  ): void {
    // Build SET clause dynamically from provided fields (still parameterized).
    const parts: string[] = [];
    const params: (string | number | null)[] = [];

    if (fields.runs_today !== undefined) {
      parts.push("runs_today = ?");
      params.push(fields.runs_today);
    }
    if ("runs_today_date" in fields) {
      parts.push("runs_today_date = ?");
      params.push(fields.runs_today_date ?? null);
    }
    if (fields.attempt_count !== undefined) {
      parts.push("attempt_count = ?");
      params.push(fields.attempt_count);
    }
    if ("next_attempt_at" in fields) {
      parts.push("next_attempt_at = ?");
      params.push(fields.next_attempt_at ?? null);
    }
    if (fields.enabled !== undefined) {
      parts.push("enabled = ?");
      params.push(fields.enabled ? 1 : 0);
    }
    if ("last_error" in fields) {
      parts.push("last_error = ?");
      params.push(fields.last_error ?? null);
    }

    if (parts.length === 0) return;

    params.push(id);
    this.#db
      .query<void, (string | number | null)[]>(
        `UPDATE scheduled_tasks SET ${parts.join(", ")} WHERE id = ?`,
      )
      .run(...params);
  }

  // ---------------------------------------------------------------------------
  // failed_tasks
  // ---------------------------------------------------------------------------

  /** Insert a dead-lettered task record. */
  insertFailedTask(entry: FailedTask): void {
    this.#db
      .query<void, [string, string, number, string, number]>(
        `INSERT INTO failed_tasks (id, task_id, run_at, error, attempt_count)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(entry.id, entry.task_id, entry.run_at, entry.error, entry.attempt_count);
  }

  /** Return all dead-lettered task entries, ordered by run_at ascending. */
  listFailedTasks(): FailedTask[] {
    const rows = this.#db
      .query<RawFailedTaskRow, []>(
        "SELECT id, task_id, run_at, error, attempt_count FROM failed_tasks ORDER BY run_at ASC",
      )
      .all();
    return rows.map(toFailedTask);
  }
}
