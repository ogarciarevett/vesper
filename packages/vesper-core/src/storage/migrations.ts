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
];
