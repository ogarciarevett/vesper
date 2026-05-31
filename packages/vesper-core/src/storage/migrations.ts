/**
 * Forward-only migration definitions for the Vesper Foundation schema.
 *
 * Each entry has a unique string id and the DDL to execute. The migration runner
 * applies them in order and records each id in `schema_migrations` so that
 * repeated calls are no-ops.
 *
 * Rules for adding migrations:
 * - APPEND ONLY — never remove or reorder existing entries.
 * - Each id must be unique and descriptive (e.g. "v1_initial_schema").
 * - A single migration entry may contain multiple DDL statements separated by semicolons;
 *   the runner executes each statement individually inside a transaction.
 */

export interface Migration {
  readonly id: string;
  /** One or more DDL statements to execute. */
  readonly sql: string;
}

/** Ordered list of all migrations. Never remove or reorder existing entries. */
export const MIGRATIONS: readonly Migration[] = [
  {
    id: "v1_initial_schema",
    sql: `
      CREATE TABLE IF NOT EXISTS events (
        id          TEXT    PRIMARY KEY NOT NULL,
        ts          INTEGER NOT NULL,
        source      TEXT    NOT NULL,
        kind        TEXT    NOT NULL,
        payload_json TEXT   NOT NULL
      );

      CREATE TABLE IF NOT EXISTS runs (
        id       TEXT    PRIMARY KEY NOT NULL,
        ts       INTEGER NOT NULL,
        pipeline TEXT    NOT NULL,
        status   TEXT    NOT NULL,
        summary  TEXT    NOT NULL
      );
    `,
  },
  {
    id: "002_scheduler",
    sql: `
      CREATE TABLE IF NOT EXISTS scheduled_tasks (
        id           TEXT    PRIMARY KEY NOT NULL,
        kind         TEXT    NOT NULL,
        schedule_expr TEXT   NOT NULL,
        handler_id   TEXT    NOT NULL,
        enabled      INTEGER NOT NULL,
        last_run_at  INTEGER,
        last_error   TEXT
      );
    `,
  },
  {
    id: "003_scheduler_guardrails",
    sql: `
      ALTER TABLE scheduled_tasks ADD COLUMN max_runs_per_day INTEGER;
      ALTER TABLE scheduled_tasks ADD COLUMN max_concurrent INTEGER;
      ALTER TABLE scheduled_tasks ADD COLUMN max_duration_ms INTEGER;
      ALTER TABLE scheduled_tasks ADD COLUMN runs_today INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE scheduled_tasks ADD COLUMN runs_today_date TEXT;
      ALTER TABLE scheduled_tasks ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE scheduled_tasks ADD COLUMN next_attempt_at INTEGER;
      CREATE TABLE IF NOT EXISTS failed_tasks (
        id            TEXT    PRIMARY KEY NOT NULL,
        task_id       TEXT    NOT NULL,
        run_at        INTEGER NOT NULL,
        error         TEXT    NOT NULL,
        attempt_count INTEGER NOT NULL
      );
    `,
  },
  {
    id: "004_capabilities",
    sql: `
      ALTER TABLE scheduled_tasks ADD COLUMN required_capabilities TEXT NOT NULL DEFAULT '[]';
    `,
  },
  {
    id: "005_task_grants",
    sql: `
      CREATE TABLE IF NOT EXISTS task_grants (
        handler_id        TEXT    NOT NULL,
        content_hash      TEXT    NOT NULL DEFAULT '',
        capabilities_json TEXT    NOT NULL DEFAULT '[]',
        granted_at        INTEGER NOT NULL,
        granted_by        TEXT    NOT NULL,
        PRIMARY KEY (handler_id, content_hash)
      );
    `,
  },
  {
    id: "006_agent_orchestration_and_trace",
    sql: `
      ALTER TABLE runs ADD COLUMN parent_run_id TEXT;
      ALTER TABLE runs ADD COLUMN status_updated_at INTEGER;
      CREATE INDEX IF NOT EXISTS idx_runs_parent ON runs(parent_run_id);
      CREATE TABLE IF NOT EXISTS run_events (
        id           TEXT    PRIMARY KEY NOT NULL,
        run_id       TEXT    NOT NULL,
        ts           INTEGER NOT NULL,
        kind         TEXT    NOT NULL,
        payload_json TEXT    NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_run_events_run ON run_events(run_id, ts);
    `,
  },
];
