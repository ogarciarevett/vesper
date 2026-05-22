/**
 * CRUD operations for the `scheduled_tasks` table.
 *
 * Uses parameterized queries exclusively (no string interpolation).
 * Raw rows are narrowed via typed assert helpers — no `any`.
 */

import type { Database } from "bun:sqlite";
import { SchedulerError } from "./errors.ts";
import type { ScheduledTask, TaskKind } from "./types.ts";

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

function toTask(raw: RawTaskRow): ScheduledTask {
  const enabledRaw = assertNumber(raw.enabled, "enabled");

  // last_run_at and last_error are nullable — SQLite returns null for NULL columns.
  let last_run_at: number | null = null;
  if (raw.last_run_at !== null) {
    last_run_at = assertNumber(raw.last_run_at, "last_run_at");
  }

  let last_error: string | null = null;
  if (raw.last_error !== null) {
    last_error = assertString(raw.last_error, "last_error");
  }

  return {
    id: assertString(raw.id, "id"),
    kind: assertTaskKind(assertString(raw.kind, "kind")),
    schedule_expr: assertString(raw.schedule_expr, "schedule_expr"),
    handler_id: assertString(raw.handler_id, "handler_id"),
    enabled: enabledRaw !== 0,
    last_run_at,
    last_error,
  };
}

const SELECT_COLUMNS = "id, kind, schedule_expr, handler_id, enabled, last_run_at, last_error";

// ---------------------------------------------------------------------------
// TaskPersistence class
// ---------------------------------------------------------------------------

/**
 * Synchronous CRUD layer for `scheduled_tasks`, injecting the `Database`
 * instance so callers control lifecycle and can use in-memory DBs in tests.
 */
export class TaskPersistence {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  /** Insert a new task row. The caller must guarantee `id` is unique. */
  insert(task: ScheduledTask): void {
    this.#db
      .query<void, [string, string, string, string, number, number | null, string | null]>(
        `INSERT INTO scheduled_tasks (id, kind, schedule_expr, handler_id, enabled, last_run_at, last_error)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        task.id,
        task.kind,
        task.schedule_expr,
        task.handler_id,
        task.enabled ? 1 : 0,
        task.last_run_at,
        task.last_error,
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
}
