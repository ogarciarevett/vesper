import { Database } from "bun:sqlite";
import { StorageError } from "./errors.ts";
import { MIGRATIONS } from "./migrations.ts";
import type {
  AppendEventInput,
  EventRow,
  ListEventsOptions,
  ListRunsOptions,
  RecordRunInput,
  RunRow,
  Store,
} from "./types.ts";

/**
 * Raw shape returned by `db.query(...).all()` for the `events` table.
 * All SQLite columns come back as primitives; we validate before casting.
 */
interface RawEventRow {
  id: unknown;
  ts: unknown;
  source: unknown;
  kind: unknown;
  payload_json: unknown;
}

/** Raw shape returned for the `runs` table. */
interface RawRunRow {
  id: unknown;
  ts: unknown;
  pipeline: unknown;
  status: unknown;
  summary: unknown;
}

/** Raw shape for a `schema_migrations` row. */
interface RawMigrationRow {
  id: unknown;
}

function assertString(value: unknown, column: string): string {
  if (typeof value !== "string") {
    throw new StorageError(
      "query_failed",
      `expected string for column "${column}", got ${typeof value}`,
    );
  }
  return value;
}

function assertNumber(value: unknown, column: string): number {
  if (typeof value !== "number") {
    throw new StorageError(
      "query_failed",
      `expected number for column "${column}", got ${typeof value}`,
    );
  }
  return value;
}

function parsePayload(raw: unknown, column: string): Record<string, unknown> {
  const json = assertString(raw, column);
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (cause) {
    throw new StorageError("query_failed", `invalid JSON in column "${column}"`, { cause });
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new StorageError("query_failed", `column "${column}" is not a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

function toEventRow(raw: RawEventRow): EventRow {
  return {
    id: assertString(raw.id, "id"),
    ts: assertNumber(raw.ts, "ts"),
    source: assertString(raw.source, "source"),
    kind: assertString(raw.kind, "kind"),
    payload: parsePayload(raw.payload_json, "payload_json"),
  };
}

function toRunRow(raw: RawRunRow): RunRow {
  return {
    id: assertString(raw.id, "id"),
    ts: assertNumber(raw.ts, "ts"),
    pipeline: assertString(raw.pipeline, "pipeline"),
    status: assertString(raw.status, "status"),
    summary: assertString(raw.summary, "summary"),
  };
}

/** {@link Store} backed by a `bun:sqlite` database. */
export class SqliteStore implements Store {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  migrate(): void {
    // Ensure schema_migrations exists before we query it.
    // This bootstrap DDL is always safe to re-run (IF NOT EXISTS).
    try {
      this.#db.run(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          id TEXT PRIMARY KEY NOT NULL
        )
      `);
    } catch (cause) {
      throw new StorageError("migration_failed", "failed to bootstrap schema_migrations table", {
        cause,
      });
    }

    // Apply each pending migration inside a single exclusive transaction.
    try {
      const checkStmt = this.#db.query<RawMigrationRow, [string]>(
        "SELECT id FROM schema_migrations WHERE id = ?",
      );
      const insertStmt = this.#db.query<void, [string]>(
        "INSERT INTO schema_migrations (id) VALUES (?)",
      );

      const applyAll = this.#db.transaction(() => {
        for (const migration of MIGRATIONS) {
          const existing = checkStmt.get(migration.id);
          if (existing !== null) continue;

          // Execute each semicolon-separated statement in the migration.
          const statements = migration.sql
            .split(";")
            .map((s) => s.trim())
            .filter((s) => s.length > 0);

          for (const statement of statements) {
            this.#db.run(statement);
          }

          insertStmt.run(migration.id);
        }
      });

      applyAll();
    } catch (cause) {
      if (cause instanceof StorageError) throw cause;
      throw new StorageError("migration_failed", "migration run failed", { cause });
    }
  }

  appendEvent(input: AppendEventInput): string {
    const id = crypto.randomUUID();
    const ts = Date.now();
    const payloadJson = JSON.stringify(input.payload);

    try {
      this.#db
        .query<void, [string, number, string, string, string]>(
          "INSERT INTO events (id, ts, source, kind, payload_json) VALUES (?, ?, ?, ?, ?)",
        )
        .run(id, ts, input.source, input.kind, payloadJson);
    } catch (cause) {
      throw new StorageError("query_failed", "failed to append event", { cause });
    }

    return id;
  }

  listEvents(options: ListEventsOptions = {}): EventRow[] {
    try {
      const conditions: string[] = [];
      const params: (string | number)[] = [];

      if (options.source !== undefined) {
        conditions.push("source = ?");
        params.push(options.source);
      }
      if (options.kind !== undefined) {
        conditions.push("kind = ?");
        params.push(options.kind);
      }

      const where = conditions.length > 0 ? ` WHERE ${conditions.join(" AND ")}` : "";
      const limitClause = options.limit !== undefined ? ` LIMIT ?` : "";
      if (options.limit !== undefined) {
        params.push(options.limit);
      }

      const sql = `SELECT id, ts, source, kind, payload_json FROM events${where} ORDER BY ts ASC${limitClause}`;
      const rows = this.#db.query<RawEventRow, (string | number)[]>(sql).all(...params);
      return rows.map(toEventRow);
    } catch (cause) {
      if (cause instanceof StorageError) throw cause;
      throw new StorageError("query_failed", "failed to list events", { cause });
    }
  }

  recordRun(input: RecordRunInput): string {
    const id = crypto.randomUUID();
    const ts = Date.now();

    try {
      this.#db
        .query<void, [string, number, string, string, string]>(
          "INSERT INTO runs (id, ts, pipeline, status, summary) VALUES (?, ?, ?, ?, ?)",
        )
        .run(id, ts, input.pipeline, input.status, input.summary);
    } catch (cause) {
      throw new StorageError("query_failed", "failed to record run", { cause });
    }

    return id;
  }

  listRuns(options: ListRunsOptions = {}): RunRow[] {
    try {
      const conditions: string[] = [];
      const params: (string | number)[] = [];

      if (options.pipeline !== undefined) {
        conditions.push("pipeline = ?");
        params.push(options.pipeline);
      }
      if (options.status !== undefined) {
        conditions.push("status = ?");
        params.push(options.status);
      }

      const where = conditions.length > 0 ? ` WHERE ${conditions.join(" AND ")}` : "";
      const limitClause = options.limit !== undefined ? ` LIMIT ?` : "";
      if (options.limit !== undefined) {
        params.push(options.limit);
      }

      const sql = `SELECT id, ts, pipeline, status, summary FROM runs${where} ORDER BY ts ASC${limitClause}`;
      const rows = this.#db.query<RawRunRow, (string | number)[]>(sql).all(...params);
      return rows.map(toRunRow);
    } catch (cause) {
      if (cause instanceof StorageError) throw cause;
      throw new StorageError("query_failed", "failed to list runs", { cause });
    }
  }

  close(): void {
    this.#db.close();
  }
}

/**
 * Open (or create) a SQLite database at `path`, run all pending migrations,
 * and return a ready-to-use {@link Store}.
 *
 * Throws {@link StorageError} with reason `"open_failed"` if the file cannot
 * be opened, or `"migration_failed"` if migrations fail.
 */
export function openStore(path: string): Store {
  let db: Database;
  try {
    db = new Database(path, { create: true });
    // WAL mode for better concurrent read performance.
    db.run("PRAGMA journal_mode = WAL");
    db.run("PRAGMA foreign_keys = ON");
  } catch (cause) {
    throw new StorageError("open_failed", `failed to open database at "${path}"`, { cause });
  }

  const store = new SqliteStore(db);
  store.migrate();
  return store;
}
