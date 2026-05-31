import { Database } from "bun:sqlite";
import type { Capability } from "../capabilities/index.ts";
import { isCapability } from "../capabilities/index.ts";
import { StorageError } from "./errors.ts";
import { MIGRATIONS } from "./migrations.ts";
import type {
  AppendEventInput,
  AppendRunEventInput,
  EventRow,
  FinishRunInput,
  ListEventsOptions,
  ListRunEventsOptions,
  ListRunsOptions,
  RecordRunInput,
  RunEventKind,
  RunEventRow,
  RunRow,
  RunTreeNode,
  StartRunInput,
  Store,
  TaskGrant,
  UpsertTaskGrantInput,
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
  parent_run_id: unknown;
  status_updated_at: unknown;
}

/** Raw shape returned for the `run_events` table. */
interface RawRunEventRow {
  id: unknown;
  run_id: unknown;
  ts: unknown;
  kind: unknown;
  payload_json: unknown;
}

/** Raw shape for a `schema_migrations` row. */
interface RawMigrationRow {
  id: unknown;
}

/** Raw shape returned for the `task_grants` table. */
interface RawTaskGrantRow {
  handler_id: unknown;
  content_hash: unknown;
  capabilities_json: unknown;
  granted_at: unknown;
  granted_by: unknown;
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

/** Narrow a nullable string column: null/undefined -> null, else delegate to assertString. */
function assertStringOrNull(value: unknown, column: string): string | null {
  if (value === null || value === undefined) return null;
  return assertString(value, column);
}

/** Narrow a nullable number column: null/undefined -> null, else delegate to assertNumber. */
function assertNumberOrNull(value: unknown, column: string): number | null {
  if (value === null || value === undefined) return null;
  return assertNumber(value, column);
}

/** Allowlist of valid `run_events.kind` values — guards against corrupted rows. */
const RUN_EVENT_KINDS: ReadonlySet<RunEventKind> = new Set<RunEventKind>([
  "step",
  "log",
  "progress",
  "spawn",
  "complete",
]);

function assertRunEventKind(value: unknown, column: string): RunEventKind {
  const str = assertString(value, column);
  if (!RUN_EVENT_KINDS.has(str as RunEventKind)) {
    throw new StorageError("query_failed", `unrecognised run_event kind "${str}"`);
  }
  return str as RunEventKind;
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
    parentRunId: assertStringOrNull(raw.parent_run_id, "parent_run_id"),
    statusUpdatedAt: assertNumberOrNull(raw.status_updated_at, "status_updated_at"),
  };
}

function toRunEventRow(raw: RawRunEventRow): RunEventRow {
  return {
    id: assertString(raw.id, "id"),
    runId: assertString(raw.run_id, "run_id"),
    ts: assertNumber(raw.ts, "ts"),
    kind: assertRunEventKind(raw.kind, "kind"),
    payload: parsePayload(raw.payload_json, "payload_json"),
  };
}

/**
 * Parse the `capabilities_json` column into a `Capability[]`, mirroring the
 * scheduler's `parseRequiredCapabilities`: JSON.parse, array-guard, and discard
 * unrecognised strings (forward-compat / corruption guard).
 */
function parseCapabilitiesJson(raw: unknown, column: string): readonly Capability[] {
  const json = assertString(raw, column);
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (cause) {
    throw new StorageError("query_failed", `invalid JSON in column "${column}"`, { cause });
  }
  if (!Array.isArray(parsed)) {
    throw new StorageError("query_failed", `column "${column}" is not a JSON array`);
  }
  return parsed.filter(isCapability);
}

function toTaskGrant(raw: RawTaskGrantRow): TaskGrant {
  return {
    handler_id: assertString(raw.handler_id, "handler_id"),
    content_hash: assertString(raw.content_hash, "content_hash"),
    capabilities: parseCapabilitiesJson(raw.capabilities_json, "capabilities_json"),
    granted_at: assertNumber(raw.granted_at, "granted_at"),
    granted_by: assertString(raw.granted_by, "granted_by"),
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
      // parent_run_id defaults to NULL (terminal, top-level row); status_updated_at
      // mirrors the insert time so the row's last-transition is recorded.
      this.#db
        .query<void, [string, number, string, string, string, number]>(
          `INSERT INTO runs (id, ts, pipeline, status, summary, status_updated_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(id, ts, input.pipeline, input.status, input.summary, ts);
    } catch (cause) {
      throw new StorageError("query_failed", "failed to record run", { cause });
    }

    return id;
  }

  startRun(input: StartRunInput): string {
    const id = input.runId ?? crypto.randomUUID();
    const ts = Date.now();
    const parentRunId = input.parentRunId ?? null;

    try {
      this.#db
        .query<void, [string, number, string, string | null, number]>(
          `INSERT INTO runs (id, ts, pipeline, status, summary, parent_run_id, status_updated_at)
           VALUES (?, ?, ?, 'running', '', ?, ?)`,
        )
        .run(id, ts, input.pipeline, parentRunId, ts);
    } catch (cause) {
      throw new StorageError("query_failed", "failed to start run", { cause });
    }

    return id;
  }

  finishRun(input: FinishRunInput): void {
    const ts = Date.now();
    try {
      const result = this.#db
        .query<void, [string, string, number, string]>(
          "UPDATE runs SET status = ?, summary = ?, status_updated_at = ? WHERE id = ?",
        )
        .run(input.status, input.summary, ts, input.runId);
      if (result.changes === 0) {
        throw new StorageError("query_failed", `no run row "${input.runId}"`);
      }
    } catch (cause) {
      if (cause instanceof StorageError) throw cause;
      throw new StorageError("query_failed", "failed to finish run", { cause });
    }
  }

  appendRunEvent(input: AppendRunEventInput): string {
    // Guard the WRITE side the same way the read side (assertRunEventKind) does:
    // a single out-of-allowlist kind would otherwise make every later
    // listRunEvents for this run throw, corrupting the whole trace.
    if (!RUN_EVENT_KINDS.has(input.kind)) {
      throw new StorageError(
        "query_failed",
        `refusing to append run event with unrecognised kind "${input.kind}"`,
      );
    }
    const id = crypto.randomUUID();
    const ts = Date.now();
    const payloadJson = JSON.stringify(input.payload);

    try {
      this.#db
        .query<void, [string, string, number, string, string]>(
          "INSERT INTO run_events (id, run_id, ts, kind, payload_json) VALUES (?, ?, ?, ?, ?)",
        )
        .run(id, input.runId, ts, input.kind, payloadJson);
    } catch (cause) {
      throw new StorageError("query_failed", "failed to append run event", { cause });
    }

    return id;
  }

  listRunEvents(options: ListRunEventsOptions): RunEventRow[] {
    try {
      const conditions: string[] = ["run_id = ?"];
      const params: (string | number)[] = [options.runId];

      if (options.afterTs !== undefined) {
        conditions.push("ts > ?");
        params.push(options.afterTs);
      }

      const where = ` WHERE ${conditions.join(" AND ")}`;
      const limitClause = options.limit !== undefined ? " LIMIT ?" : "";
      if (options.limit !== undefined) {
        params.push(options.limit);
      }

      const sql = `SELECT id, run_id, ts, kind, payload_json FROM run_events${where} ORDER BY ts ASC${limitClause}`;
      const rows = this.#db.query<RawRunEventRow, (string | number)[]>(sql).all(...params);
      return rows.map(toRunEventRow);
    } catch (cause) {
      if (cause instanceof StorageError) throw cause;
      throw new StorageError("query_failed", "failed to list run events", { cause });
    }
  }

  runTree(rootRunId: string): RunTreeNode | null {
    try {
      const root = this.#getRunById(rootRunId);
      if (root === null) return null;
      return this.#buildRunTree(root, new Set<string>());
    } catch (cause) {
      if (cause instanceof StorageError) throw cause;
      throw new StorageError("query_failed", "failed to assemble run tree", { cause });
    }
  }

  /** Fetch a single run row by id, or null when absent. */
  #getRunById(id: string): RunRow | null {
    const row = this.#db
      .query<RawRunRow, [string]>(
        `SELECT id, ts, pipeline, status, summary, parent_run_id, status_updated_at
         FROM runs WHERE id = ?`,
      )
      .get(id);
    return row !== null ? toRunRow(row) : null;
  }

  /**
   * Recursively assemble the {@link RunTreeNode} for `run`. `seen` guards against
   * a cyclic parent_run_id chain (data corruption) so the recursion terminates.
   */
  #buildRunTree(run: RunRow, seen: ReadonlySet<string>): RunTreeNode {
    if (seen.has(run.id)) {
      return { run, children: [] };
    }
    const nextSeen = new Set(seen);
    nextSeen.add(run.id);

    const childRows = this.listRuns({ parentRunId: run.id });
    const children = childRows.map((child) => this.#buildRunTree(child, nextSeen));
    return { run, children };
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
      // Three-way parentRunId semantics: omitted = no filter; null = only
      // top-level; string = that parent's children.
      if (Object.hasOwn(options, "parentRunId")) {
        if (options.parentRunId === null) {
          conditions.push("parent_run_id IS NULL");
        } else if (options.parentRunId !== undefined) {
          conditions.push("parent_run_id = ?");
          params.push(options.parentRunId);
        }
      }

      const where = conditions.length > 0 ? ` WHERE ${conditions.join(" AND ")}` : "";
      const limitClause = options.limit !== undefined ? ` LIMIT ?` : "";
      if (options.limit !== undefined) {
        params.push(options.limit);
      }

      const sql = `SELECT id, ts, pipeline, status, summary, parent_run_id, status_updated_at FROM runs${where} ORDER BY ts ASC${limitClause}`;
      const rows = this.#db.query<RawRunRow, (string | number)[]>(sql).all(...params);
      return rows.map(toRunRow);
    } catch (cause) {
      if (cause instanceof StorageError) throw cause;
      throw new StorageError("query_failed", "failed to list runs", { cause });
    }
  }

  upsertTaskGrant(input: UpsertTaskGrantInput): void {
    const contentHash = input.content_hash ?? "";
    const capabilitiesJson = JSON.stringify([...input.capabilities]);
    const grantedAt = input.granted_at ?? Date.now();

    try {
      this.#db
        .query<void, [string, string, string, number, string]>(
          `INSERT INTO task_grants (handler_id, content_hash, capabilities_json, granted_at, granted_by)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(handler_id, content_hash) DO UPDATE SET
             capabilities_json = excluded.capabilities_json,
             granted_at = excluded.granted_at,
             granted_by = excluded.granted_by`,
        )
        .run(input.handler_id, contentHash, capabilitiesJson, grantedAt, input.granted_by);
    } catch (cause) {
      throw new StorageError("query_failed", "failed to upsert task grant", { cause });
    }
  }

  getTaskGrant(handlerId: string, contentHash?: string): TaskGrant | null {
    try {
      const row = this.#db
        .query<RawTaskGrantRow, [string, string]>(
          `SELECT handler_id, content_hash, capabilities_json, granted_at, granted_by
           FROM task_grants WHERE handler_id = ? AND content_hash = ?`,
        )
        .get(handlerId, contentHash ?? "");
      return row !== null ? toTaskGrant(row) : null;
    } catch (cause) {
      if (cause instanceof StorageError) throw cause;
      throw new StorageError("query_failed", "failed to read task grant", { cause });
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
