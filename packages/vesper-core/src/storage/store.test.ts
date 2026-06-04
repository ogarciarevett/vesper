import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StorageError } from "./errors.ts";
import { MIGRATIONS } from "./migrations.ts";
import { openStore, SqliteStore } from "./store.ts";
import type { RunEventKind, Store } from "./types.ts";

/** Split a migration's `sql` into individual statements (mirrors the runner). */
function statementsOf(sql: string): string[] {
  return sql
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Create a unique temp file path for each test; cleaned up in afterEach. */
function tempDbPath(): string {
  return join(tmpdir(), `vesper-test-${crypto.randomUUID()}.db`);
}

// ---------------------------------------------------------------------------
// openStore / migrate
// ---------------------------------------------------------------------------

describe("openStore", () => {
  let path: string;

  beforeEach(() => {
    path = tempDbPath();
  });

  afterEach(() => {
    // Best-effort cleanup; ignore errors if the file was never created.
    try {
      rmSync(path, { force: true });
      // WAL mode creates a -shm and -wal sidecar; remove those too.
      rmSync(`${path}-shm`, { force: true });
      rmSync(`${path}-wal`, { force: true });
    } catch {
      // ignore
    }
  });

  test("GIVEN a fresh path WHEN openStore THEN file is created and schema_migrations has v1 row", () => {
    const store = openStore(path);
    store.close();

    // Reopen raw to verify the migrations table content.
    const db = new Database(path, { readonly: true });
    const rows = db.query<{ id: string }, []>("SELECT id FROM schema_migrations").all();
    db.close();

    // The migration count grows as new migrations are added; check the v1 row is present.
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0]?.id).toBe("v1_initial_schema");
  });

  test("GIVEN openStore called THEN events and runs tables exist", () => {
    const store = openStore(path);
    store.close();

    const db = new Database(path, { readonly: true });
    // If these queries don't throw, the tables exist.
    db.query("SELECT count(*) FROM events").get();
    db.query("SELECT count(*) FROM runs").get();
    db.close();
  });

  test("migrate() called again is idempotent — schema_migrations row count stays stable", () => {
    const store = openStore(path);
    // Call migrate() a second and third time — should be no-ops.
    store.migrate();
    const countAfterFirst = (() => {
      const db = new Database(path, { readonly: true });
      const rows = db.query<{ id: string }, []>("SELECT id FROM schema_migrations").all();
      db.close();
      return rows.length;
    })();
    store.migrate();
    store.close();

    const db = new Database(path, { readonly: true });
    const rows = db.query<{ id: string }, []>("SELECT id FROM schema_migrations").all();
    db.close();

    expect(rows.length).toBe(countAfterFirst);
  });
});

// ---------------------------------------------------------------------------
// appendEvent / listEvents
// ---------------------------------------------------------------------------

describe("appendEvent and listEvents", () => {
  let path: string;
  let store: Store;

  beforeEach(() => {
    path = tempDbPath();
    store = openStore(path);
  });

  afterEach(() => {
    store.close();
    try {
      rmSync(path, { force: true });
      rmSync(`${path}-shm`, { force: true });
      rmSync(`${path}-wal`, { force: true });
    } catch {
      // ignore
    }
  });

  test("appendEvent returns a non-empty string id", () => {
    const id = store.appendEvent({ source: "test", kind: "ping", payload: {} });
    expect(typeof id).toBe("string");
    expect(id.length).toBeGreaterThan(0);
  });

  test("appendEvent then listEvents returns the row with correct fields", () => {
    store.appendEvent({ source: "src-a", kind: "ping", payload: { x: 42 } });
    const rows = store.listEvents();

    expect(rows).toHaveLength(1);
    expect(rows[0]?.source).toBe("src-a");
    expect(rows[0]?.kind).toBe("ping");
    expect(rows[0]?.payload).toEqual({ x: 42 });
    expect(typeof rows[0]?.ts).toBe("number");
  });

  test("event survives close and reopen", () => {
    store.appendEvent({ source: "persist-src", kind: "saved", payload: { val: "hello" } });
    store.close();

    const reopened = openStore(path);
    const rows = reopened.listEvents();
    reopened.close();

    expect(rows).toHaveLength(1);
    expect(rows[0]?.source).toBe("persist-src");
    expect(rows[0]?.kind).toBe("saved");
    expect(rows[0]?.payload).toEqual({ val: "hello" });
  });

  test("listEvents with source filter returns matching rows only", () => {
    store.appendEvent({ source: "a", kind: "k", payload: {} });
    store.appendEvent({ source: "b", kind: "k", payload: {} });
    store.appendEvent({ source: "a", kind: "k2", payload: {} });

    const filtered = store.listEvents({ source: "a" });
    expect(filtered).toHaveLength(2);
    for (const row of filtered) {
      expect(row.source).toBe("a");
    }
  });

  test("listEvents with kind filter returns matching rows only", () => {
    store.appendEvent({ source: "s", kind: "ping", payload: {} });
    store.appendEvent({ source: "s", kind: "pong", payload: {} });

    const filtered = store.listEvents({ kind: "ping" });
    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.kind).toBe("ping");
  });

  test("listEvents with limit returns at most N rows", () => {
    store.appendEvent({ source: "s", kind: "e", payload: {} });
    store.appendEvent({ source: "s", kind: "e", payload: {} });
    store.appendEvent({ source: "s", kind: "e", payload: {} });

    const limited = store.listEvents({ limit: 2 });
    expect(limited).toHaveLength(2);
  });

  test("listEvents with combined source and kind filters", () => {
    store.appendEvent({ source: "a", kind: "x", payload: {} });
    store.appendEvent({ source: "a", kind: "y", payload: {} });
    store.appendEvent({ source: "b", kind: "x", payload: {} });

    const filtered = store.listEvents({ source: "a", kind: "x" });
    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.source).toBe("a");
    expect(filtered[0]?.kind).toBe("x");
  });

  test("listEvents on empty store returns empty array", () => {
    expect(store.listEvents()).toEqual([]);
  });

  test("payload with nested objects round-trips correctly", () => {
    const payload = { nested: { deep: [1, 2, 3] }, flag: true };
    store.appendEvent({ source: "s", kind: "k", payload });
    const rows = store.listEvents();
    expect(rows[0]?.payload).toEqual(payload);
  });
});

// ---------------------------------------------------------------------------
// recordRun / listRuns
// ---------------------------------------------------------------------------

describe("recordRun and listRuns", () => {
  let path: string;
  let store: Store;

  beforeEach(() => {
    path = tempDbPath();
    store = openStore(path);
  });

  afterEach(() => {
    store.close();
    try {
      rmSync(path, { force: true });
      rmSync(`${path}-shm`, { force: true });
      rmSync(`${path}-wal`, { force: true });
    } catch {
      // ignore
    }
  });

  test("recordRun returns a non-empty string id", () => {
    const id = store.recordRun({ pipeline: "career", status: "ok", summary: "done" });
    expect(typeof id).toBe("string");
    expect(id.length).toBeGreaterThan(0);
  });

  test("recordRun then listRuns returns the row with correct fields", () => {
    store.recordRun({ pipeline: "career", status: "ok", summary: "finished" });
    const rows = store.listRuns();

    expect(rows).toHaveLength(1);
    expect(rows[0]?.pipeline).toBe("career");
    expect(rows[0]?.status).toBe("ok");
    expect(rows[0]?.summary).toBe("finished");
    expect(typeof rows[0]?.ts).toBe("number");
  });

  test("run survives close and reopen", () => {
    store.recordRun({ pipeline: "career", status: "ok", summary: "done" });
    store.close();

    const reopened = openStore(path);
    const rows = reopened.listRuns();
    reopened.close();

    expect(rows).toHaveLength(1);
    expect(rows[0]?.pipeline).toBe("career");
    expect(rows[0]?.status).toBe("ok");
    expect(rows[0]?.summary).toBe("done");
  });

  test("listRuns with pipeline filter returns matching rows only", () => {
    store.recordRun({ pipeline: "career", status: "ok", summary: "" });
    store.recordRun({ pipeline: "social", status: "ok", summary: "" });

    const filtered = store.listRuns({ pipeline: "career" });
    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.pipeline).toBe("career");
  });

  test("listRuns with status filter returns matching rows only", () => {
    store.recordRun({ pipeline: "career", status: "ok", summary: "" });
    store.recordRun({ pipeline: "career", status: "error", summary: "" });

    const filtered = store.listRuns({ status: "error" });
    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.status).toBe("error");
  });

  test("listRuns with limit returns at most N rows", () => {
    store.recordRun({ pipeline: "p", status: "ok", summary: "" });
    store.recordRun({ pipeline: "p", status: "ok", summary: "" });
    store.recordRun({ pipeline: "p", status: "ok", summary: "" });

    const limited = store.listRuns({ limit: 1 });
    expect(limited).toHaveLength(1);
  });

  test("listRuns on empty store returns empty array", () => {
    expect(store.listRuns()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// SQL injection resistance
// ---------------------------------------------------------------------------

describe("SQL injection resistance", () => {
  let path: string;
  let store: Store;

  beforeEach(() => {
    path = tempDbPath();
    store = openStore(path);
  });

  afterEach(() => {
    store.close();
    try {
      rmSync(path, { force: true });
      rmSync(`${path}-shm`, { force: true });
      rmSync(`${path}-wal`, { force: true });
    } catch {
      // ignore
    }
  });

  test("malicious source string does NOT execute as SQL — runs table survives", () => {
    // Record a legitimate run first so we can verify it is still there.
    store.recordRun({ pipeline: "safe-pipeline", status: "ok", summary: "initial" });

    // Pass a DROP TABLE attempt as the source value.
    store.appendEvent({
      source: "'; DROP TABLE runs; --",
      kind: "attack",
      payload: { attempt: "sqli" },
    });

    // The runs table must still exist and contain the original row.
    const runs = store.listRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0]?.pipeline).toBe("safe-pipeline");

    // The events table must contain the malicious string as literal data, not executed SQL.
    const events = store.listEvents();
    expect(events).toHaveLength(1);
    expect(events[0]?.source).toBe("'; DROP TABLE runs; --");
  });

  test("malicious pipeline name does NOT execute as SQL — events table survives", () => {
    store.appendEvent({ source: "s", kind: "k", payload: {} });

    store.recordRun({
      pipeline: "'; DROP TABLE events; --",
      status: "ok",
      summary: "attack",
    });

    const events = store.listEvents();
    expect(events).toHaveLength(1);

    const runs = store.listRuns();
    expect(runs[0]?.pipeline).toBe("'; DROP TABLE events; --");
  });
});

// ---------------------------------------------------------------------------
// StorageError wrapping
// ---------------------------------------------------------------------------

describe("StorageError", () => {
  test("StorageError has code 'storage' and the given reason", () => {
    const err = new StorageError("open_failed", "test");
    expect(err.code).toBe("storage");
    expect(err.reason).toBe("open_failed");
    expect(err.message).toBe("test");
    expect(err.name).toBe("StorageError");
  });

  test("StorageError is instanceof Error and StorageError", () => {
    const err = new StorageError("query_failed", "boom");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(StorageError);
  });

  test("StorageError preserves cause", () => {
    const cause = new Error("root cause");
    const err = new StorageError("migration_failed", "wrapper", { cause });
    expect(err.cause).toBe(cause);
  });

  test("openStore on an invalid path throws StorageError(open_failed)", () => {
    expect(() => openStore("/this/path/does/not/exist/db.sqlite")).toThrow(StorageError);
    try {
      openStore("/this/path/does/not/exist/db.sqlite");
    } catch (e: unknown) {
      expect(e).toBeInstanceOf(StorageError);
      expect((e as StorageError).reason).toBe("open_failed");
    }
  });
});

// ---------------------------------------------------------------------------
// SqliteStore with injected Database (unit-level)
// ---------------------------------------------------------------------------

describe("SqliteStore (in-memory)", () => {
  test("works with an in-memory database", () => {
    const db = new Database(":memory:");
    const store = new SqliteStore(db);
    store.migrate();

    const eventId = store.appendEvent({ source: "mem", kind: "test", payload: { n: 1 } });
    expect(typeof eventId).toBe("string");

    const runId = store.recordRun({ pipeline: "p", status: "ok", summary: "s" });
    expect(typeof runId).toBe("string");

    const events = store.listEvents();
    expect(events).toHaveLength(1);

    const runs = store.listRuns();
    expect(runs).toHaveLength(1);

    store.close();
  });

  test("migrate() on a fresh in-memory db inserts v1_initial_schema", () => {
    const db = new Database(":memory:");
    const store = new SqliteStore(db);
    store.migrate();

    const rows = db.query<{ id: string }, []>("SELECT id FROM schema_migrations").all();
    expect(rows[0]?.id).toBe("v1_initial_schema");

    store.close();
  });

  test("multiple migrate() calls on in-memory db remain idempotent", () => {
    const db = new Database(":memory:");
    const store = new SqliteStore(db);
    store.migrate();
    const countAfterFirst = db
      .query<{ id: string }, []>("SELECT id FROM schema_migrations")
      .all().length;
    store.migrate();
    store.migrate();

    const rows = db.query<{ id: string }, []>("SELECT id FROM schema_migrations").all();
    // Count must not grow beyond what was applied on the first migrate() call.
    expect(rows.length).toBe(countAfterFirst);

    store.close();
  });
});

// ---------------------------------------------------------------------------
// task_grants (migration 005) — per-task capability grants
// ---------------------------------------------------------------------------

describe("task_grants round-trip", () => {
  let path: string;
  let store: Store;

  beforeEach(() => {
    path = tempDbPath();
    store = openStore(path);
  });

  afterEach(() => {
    store.close();
    try {
      rmSync(path, { force: true });
      rmSync(`${path}-shm`, { force: true });
      rmSync(`${path}-wal`, { force: true });
    } catch {
      // ignore
    }
  });

  test("upsertTaskGrant then getTaskGrant returns the grant with defaulted content_hash", () => {
    store.upsertTaskGrant({ handler_id: "h", capabilities: ["FS_READ"], granted_by: "register" });

    const grant = store.getTaskGrant("h");
    expect(grant).not.toBeNull();
    expect(grant?.handler_id).toBe("h");
    expect(grant?.content_hash).toBe("");
    expect(grant?.capabilities).toEqual(["FS_READ"]);
    expect(grant?.granted_by).toBe("register");
    expect(typeof grant?.granted_at).toBe("number");
  });

  test("getTaskGrant returns null for a missing handler", () => {
    expect(store.getTaskGrant("missing")).toBeNull();
  });

  test("upsert again with different caps UPDATES the row (ON CONFLICT), no duplicate", () => {
    store.upsertTaskGrant({ handler_id: "h", capabilities: ["FS_READ"], granted_by: "register" });
    store.upsertTaskGrant({
      handler_id: "h",
      capabilities: ["FS_READ", "WRITE_STORAGE"],
      granted_by: "forge",
    });

    const grant = store.getTaskGrant("h");
    expect(grant?.capabilities).toEqual(["FS_READ", "WRITE_STORAGE"]);
    expect(grant?.granted_by).toBe("forge");

    // Composite PK (handler_id, '') means exactly one row for this handler+hash.
    const db = new Database(path, { readonly: true });
    const countRow = db
      .query<{ c: number }, [string]>(
        "SELECT count(*) AS c FROM task_grants WHERE handler_id = ? AND content_hash = ''",
      )
      .get("h");
    db.close();
    expect(countRow?.c).toBe(1);
  });

  test("content_hash variant is a SEPARATE row (composite PK)", () => {
    store.upsertTaskGrant({ handler_id: "h", capabilities: ["FS_READ"], granted_by: "register" });
    store.upsertTaskGrant({
      handler_id: "h",
      content_hash: "abc",
      capabilities: ["NETWORK_FETCH"],
      granted_by: "forge",
    });

    const empty = store.getTaskGrant("h");
    const hashed = store.getTaskGrant("h", "abc");
    expect(empty?.capabilities).toEqual(["FS_READ"]);
    expect(hashed?.capabilities).toEqual(["NETWORK_FETCH"]);
    expect(hashed?.content_hash).toBe("abc");
  });

  test("explicit granted_at is preserved on the row", () => {
    store.upsertTaskGrant({
      handler_id: "h",
      capabilities: ["CLI_INVOKE"],
      granted_by: "register",
      granted_at: 12345,
    });
    expect(store.getTaskGrant("h")?.granted_at).toBe(12345);
  });

  test("empty capabilities round-trips as an empty array", () => {
    store.upsertTaskGrant({ handler_id: "empty", capabilities: [], granted_by: "register" });
    expect(store.getTaskGrant("empty")?.capabilities).toEqual([]);
  });
});

describe("migration 005_task_grants idempotency", () => {
  let path: string;

  beforeEach(() => {
    path = tempDbPath();
  });

  afterEach(() => {
    try {
      rmSync(path, { force: true });
      rmSync(`${path}-shm`, { force: true });
      rmSync(`${path}-wal`, { force: true });
    } catch {
      // ignore
    }
  });

  test("schema_migrations records 005_task_grants and reopen is a no-op", () => {
    const first = openStore(path);
    first.close();

    // Reopen the same file — migrate() runs again and must not throw.
    const second = openStore(path);
    second.close();

    const db = new Database(path, { readonly: true });
    const ids = db
      .query<{ id: string }, []>("SELECT id FROM schema_migrations")
      .all()
      .map((r) => r.id);
    // The task_grants table must exist (querying it must not throw).
    expect(() => db.query("SELECT count(*) FROM task_grants").get()).not.toThrow();
    db.close();

    expect(ids).toContain("005_task_grants");
  });
});

// ---------------------------------------------------------------------------
// Migration 006 — agent orchestration + trace (forward-only)
// ---------------------------------------------------------------------------

describe("migration 006 — agent orchestration and trace", () => {
  let path: string;

  beforeEach(() => {
    path = tempDbPath();
  });

  afterEach(() => {
    try {
      rmSync(path, { force: true });
      rmSync(`${path}-shm`, { force: true });
      rmSync(`${path}-wal`, { force: true });
    } catch {
      // ignore
    }
  });

  test("legacy recordRun rows read back with parentRunId null and statusUpdatedAt set", () => {
    const store = openStore(path);
    store.recordRun({ pipeline: "echo", status: "ok", summary: "legacy" });
    store.close();

    // Reopen and read it back through listRuns — the new columns must default
    // safely (parent_run_id NULL; status_updated_at set by recordRun).
    const reopened = openStore(path);
    const runs = reopened.listRuns({ pipeline: "echo" });
    reopened.close();

    expect(runs).toHaveLength(1);
    expect(runs[0]?.parentRunId).toBeNull();
    expect(runs[0]?.statusUpdatedAt).not.toBeNull();
    expect(typeof runs[0]?.statusUpdatedAt).toBe("number");
  });

  test("a runs row written BEFORE migration 006 reads back parent_run_id/status_updated_at NULL", () => {
    // Forward-compat acceptance: a genuine pre-006 row (written before the
    // ALTER TABLE runs ADD COLUMN) must read back with the new columns NULL.
    // The old "legacy recordRun" test opens an ALL-migrations store first, so it
    // never exercises this — here we apply 001..005, insert, THEN apply 006 onward.
    // All subsequent migrations (007, 008) are also applied so the SqliteStore's
    // queries — which reference all columns — can execute against a complete schema.
    const db = new Database(":memory:");
    const idx006 = MIGRATIONS.findIndex((m) => m.id.startsWith("006"));
    expect(idx006).toBeGreaterThan(0);

    for (const m of MIGRATIONS.slice(0, idx006)) {
      for (const stmt of statementsOf(m.sql)) db.run(stmt);
    }
    // A pre-006 row: only the original five columns exist at this point.
    db.run(
      "INSERT INTO runs (id, ts, pipeline, status, summary) VALUES ('legacy-1', 1000, 'echo', 'ok', 'pre-006')",
    );
    // Apply migration 006 and all subsequent migrations so the schema is complete.
    for (const m of MIGRATIONS.slice(idx006)) {
      for (const stmt of statementsOf(m.sql)) db.run(stmt);
    }

    const runs = new SqliteStore(db).listRuns({ pipeline: "echo" });
    db.close();

    expect(runs).toHaveLength(1);
    expect(runs[0]?.id).toBe("legacy-1");
    expect(runs[0]?.parentRunId).toBeNull();
    expect(runs[0]?.statusUpdatedAt).toBeNull();
    // The 008 columns default to NULL for a pre-006 row — context is absent.
    expect(runs[0]?.context).toBeNull();
  });

  test("schema_migrations records 006 and reopen is idempotent (run_events queryable)", () => {
    const first = openStore(path);
    first.close();
    const second = openStore(path);
    second.close();

    const db = new Database(path, { readonly: true });
    const ids = db
      .query<{ id: string }, []>("SELECT id FROM schema_migrations")
      .all()
      .map((r) => r.id);
    expect(() => db.query("SELECT count(*) FROM run_events").get()).not.toThrow();
    db.close();

    expect(ids).toContain("006_agent_orchestration_and_trace");
    // 006 applied exactly once even across two opens.
    expect(ids.filter((id) => id === "006_agent_orchestration_and_trace")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// startRun / finishRun
// ---------------------------------------------------------------------------

describe("startRun and finishRun", () => {
  let path: string;
  let store: Store;

  beforeEach(() => {
    path = tempDbPath();
    store = openStore(path);
  });

  afterEach(() => {
    store.close();
    try {
      rmSync(path, { force: true });
      rmSync(`${path}-shm`, { force: true });
      rmSync(`${path}-wal`, { force: true });
    } catch {
      // ignore
    }
  });

  test("startRun inserts a running row with parentRunId and statusUpdatedAt set", () => {
    const id = store.startRun({ pipeline: "p", parentRunId: "parent-1" });
    const runs = store.listRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0]?.id).toBe(id);
    expect(runs[0]?.status).toBe("running");
    expect(runs[0]?.summary).toBe("");
    expect(runs[0]?.parentRunId).toBe("parent-1");
    expect(runs[0]?.statusUpdatedAt).not.toBeNull();
  });

  test("startRun without parentRunId is a top-level run", () => {
    store.startRun({ pipeline: "p" });
    const top = store.listRuns({ parentRunId: null });
    expect(top).toHaveLength(1);
    expect(top[0]?.parentRunId).toBeNull();
  });

  test("startRun honors an explicit runId", () => {
    const explicit = "11111111-2222-4333-8444-555555555555";
    const id = store.startRun({ pipeline: "p", runId: explicit });
    expect(id).toBe(explicit);
    expect(store.listRuns()[0]?.id).toBe(explicit);
  });

  test("finishRun updates the same row to terminal status without duplicating", () => {
    const id = store.startRun({ pipeline: "p" });
    store.finishRun({ runId: id, status: "ok", summary: "done" });

    const runs = store.listRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0]?.id).toBe(id);
    expect(runs[0]?.status).toBe("ok");
    expect(runs[0]?.summary).toBe("done");
  });

  test("finishRun bumps status_updated_at", () => {
    const id = store.startRun({ pipeline: "p" });
    const started = store.listRuns()[0]?.statusUpdatedAt ?? 0;
    Bun.sleepSync(2);
    store.finishRun({ runId: id, status: "ok", summary: "" });
    const finished = store.listRuns()[0]?.statusUpdatedAt ?? 0;
    expect(finished).toBeGreaterThanOrEqual(started);
  });

  test("finishRun on an unknown runId throws StorageError query_failed", () => {
    expect(() => store.finishRun({ runId: "nope", status: "ok", summary: "" })).toThrow(
      StorageError,
    );
    try {
      store.finishRun({ runId: "nope", status: "ok", summary: "" });
    } catch (err) {
      expect((err as StorageError).reason).toBe("query_failed");
    }
  });
});

// ---------------------------------------------------------------------------
// appendRunEvent / listRunEvents
// ---------------------------------------------------------------------------

describe("appendRunEvent and listRunEvents", () => {
  let path: string;
  let store: Store;

  beforeEach(() => {
    path = tempDbPath();
    store = openStore(path);
  });

  afterEach(() => {
    store.close();
    try {
      rmSync(path, { force: true });
      rmSync(`${path}-shm`, { force: true });
      rmSync(`${path}-wal`, { force: true });
    } catch {
      // ignore
    }
  });

  test("appendRunEvent then listRunEvents returns the row with parsed payload + kind", () => {
    const runId = store.startRun({ pipeline: "p" });
    const evtId = store.appendRunEvent({
      runId,
      kind: "step",
      payload: { message: "doing a thing", data: { pct: 25 } },
    });
    expect(typeof evtId).toBe("string");

    const events = store.listRunEvents({ runId });
    expect(events).toHaveLength(1);
    expect(events[0]?.id).toBe(evtId);
    expect(events[0]?.runId).toBe(runId);
    expect(events[0]?.kind).toBe("step");
    expect(events[0]?.payload).toEqual({ message: "doing a thing", data: { pct: 25 } });
  });

  test("an unknown kind column value throws StorageError", () => {
    const runId = store.startRun({ pipeline: "p" });
    // Insert a corrupt row directly, bypassing the typed API.
    const db = new Database(path);
    db.query(
      "INSERT INTO run_events (id, run_id, ts, kind, payload_json) VALUES (?, ?, ?, ?, ?)",
    ).run(crypto.randomUUID(), runId, Date.now(), "bogus_kind", "{}");
    db.close();

    expect(() => store.listRunEvents({ runId })).toThrow(StorageError);
  });

  test("afterTs filters strictly (ts > afterTs) and orders ascending", () => {
    const runId = store.startRun({ pipeline: "p" });
    store.appendRunEvent({ runId, kind: "step", payload: { n: 1 } });
    Bun.sleepSync(2);
    const cutoff = Date.now();
    Bun.sleepSync(2);
    store.appendRunEvent({ runId, kind: "step", payload: { n: 2 } });

    const after = store.listRunEvents({ runId, afterTs: cutoff });
    expect(after).toHaveLength(1);
    expect(after[0]?.payload).toEqual({ n: 2 });

    const all = store.listRunEvents({ runId });
    expect(all).toHaveLength(2);
    expect(all[0]?.payload).toEqual({ n: 1 });
    expect(all[1]?.payload).toEqual({ n: 2 });
  });

  test("limit caps the number of returned events", () => {
    const runId = store.startRun({ pipeline: "p" });
    for (let i = 0; i < 5; i++) {
      store.appendRunEvent({ runId, kind: "log", payload: { i } });
    }
    expect(store.listRunEvents({ runId, limit: 2 })).toHaveLength(2);
  });

  test("appendRunEvent refuses an out-of-allowlist kind (write-side guard)", () => {
    const runId = store.startRun({ pipeline: "p" });
    expect(() =>
      // Cast past the typed boundary to simulate a JS caller or a future bad cast.
      store.appendRunEvent({ runId, kind: "bogus_kind" as RunEventKind, payload: {} }),
    ).toThrow(StorageError);
    // The bad write was rejected, so the run's trace stays readable.
    expect(store.listRunEvents({ runId })).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// listRuns parentRunId three-way filter + runTree
// ---------------------------------------------------------------------------

describe("listRuns parentRunId filter and runTree", () => {
  let path: string;
  let store: Store;

  beforeEach(() => {
    path = tempDbPath();
    store = openStore(path);
  });

  afterEach(() => {
    store.close();
    try {
      rmSync(path, { force: true });
      rmSync(`${path}-shm`, { force: true });
      rmSync(`${path}-wal`, { force: true });
    } catch {
      // ignore
    }
  });

  test("three-way parentRunId distinction (omitted vs null vs string)", () => {
    const parent = store.startRun({ pipeline: "parent" });
    const c1 = store.startRun({ pipeline: "child", parentRunId: parent });
    const c2 = store.startRun({ pipeline: "child", parentRunId: parent });
    const c3 = store.startRun({ pipeline: "child", parentRunId: parent });

    // omitted = all rows
    expect(store.listRuns()).toHaveLength(4);
    // null = only top-level
    const top = store.listRuns({ parentRunId: null });
    expect(top).toHaveLength(1);
    expect(top[0]?.id).toBe(parent);
    // string = only that parent's children
    const children = store.listRuns({ parentRunId: parent });
    expect(children.map((r) => r.id).sort()).toEqual([c1, c2, c3].sort());
  });

  test("runTree assembles parent with its children", () => {
    const parent = store.startRun({ pipeline: "parent" });
    const c1 = store.startRun({ pipeline: "child", parentRunId: parent });
    const c2 = store.startRun({ pipeline: "child", parentRunId: parent });
    const c3 = store.startRun({ pipeline: "child", parentRunId: parent });

    const tree = store.runTree(parent);
    expect(tree).not.toBeNull();
    expect(tree?.run.id).toBe(parent);
    expect(tree?.children).toHaveLength(3);
    const childIds = tree?.children.map((node) => node.run.id).sort();
    expect(childIds).toEqual([c1, c2, c3].sort());
    // Children are leaves (no grandchildren by spawn rules).
    expect(tree?.children.every((node) => node.children.length === 0)).toBe(true);
  });

  test("runTree of an unknown id returns null", () => {
    expect(store.runTree("does-not-exist")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Chat home (migration 007_chat_home)
// ---------------------------------------------------------------------------

describe("chat sessions and turns", () => {
  let path: string;
  let store: Store;

  beforeEach(() => {
    path = tempDbPath();
    store = openStore(path);
  });

  afterEach(() => {
    store.close();
    try {
      rmSync(path, { force: true });
      rmSync(`${path}-shm`, { force: true });
      rmSync(`${path}-wal`, { force: true });
    } catch {
      // ignore
    }
  });

  test("createSession returns a generated id and listSessions reads it back", () => {
    const id = store.createSession({ title: "first wish" });
    expect(typeof id).toBe("string");
    expect(id.length).toBeGreaterThan(0);

    const sessions = store.listSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.id).toBe(id);
    expect(sessions[0]?.title).toBe("first wish");
    expect(typeof sessions[0]?.ts).toBe("number");
  });

  test("createSession honors a supplied id", () => {
    const id = store.createSession({ id: "11111111-1111-4111-8111-111111111111", title: "x" });
    expect(id).toBe("11111111-1111-4111-8111-111111111111");
  });

  test("listSessions is newest-first", () => {
    const a = store.createSession({ title: "a" });
    const b = store.createSession({ title: "b" });
    const ids = store.listSessions().map((s) => s.id);
    // b was created after a, so it sorts first (ts DESC).
    expect(ids[0]).toBe(b);
    expect(ids).toContain(a);
  });

  test("appendTurn persists user and assistant turns; listTurns is oldest-first", () => {
    const session = store.createSession({ title: "t" });
    const userTurn = store.appendTurn({ sessionId: session, role: "user", text: "do a thing" });
    const asstTurn = store.appendTurn({
      sessionId: session,
      role: "assistant",
      text: "on it",
      runId: "22222222-2222-4222-8222-222222222222",
    });

    const turns = store.listTurns({ sessionId: session });
    expect(turns.map((t) => t.id)).toEqual([userTurn, asstTurn]);
    expect(turns[0]?.role).toBe("user");
    expect(turns[0]?.runId).toBeNull();
    expect(turns[1]?.role).toBe("assistant");
    expect(turns[1]?.runId).toBe("22222222-2222-4222-8222-222222222222");
  });

  test("listTurns filters by afterTs and respects limit", () => {
    const session = store.createSession({ title: "t" });
    store.appendTurn({ sessionId: session, role: "user", text: "one" });
    const all = store.listTurns({ sessionId: session });
    const firstTs = all[0]?.ts ?? 0;

    // afterTs strictly greater — the only turn (ts == firstTs) is excluded.
    expect(store.listTurns({ sessionId: session, afterTs: firstTs })).toHaveLength(0);

    store.appendTurn({ sessionId: session, role: "assistant", text: "two" });
    store.appendTurn({ sessionId: session, role: "assistant", text: "three" });
    expect(store.listTurns({ sessionId: session, limit: 1 })).toHaveLength(1);
  });

  test("listTurns scopes to its session only", () => {
    const s1 = store.createSession({ title: "s1" });
    const s2 = store.createSession({ title: "s2" });
    store.appendTurn({ sessionId: s1, role: "user", text: "a" });
    store.appendTurn({ sessionId: s2, role: "user", text: "b" });
    expect(store.listTurns({ sessionId: s1 })).toHaveLength(1);
    expect(store.listTurns({ sessionId: s1 })[0]?.text).toBe("a");
  });

  test("turns survive reopen (durable transcript)", () => {
    const session = store.createSession({ title: "t" });
    store.appendTurn({ sessionId: session, role: "user", text: "persisted" });
    store.close();

    const reopened = openStore(path);
    const turns = reopened.listTurns({ sessionId: session });
    reopened.close();
    expect(turns).toHaveLength(1);
    expect(turns[0]?.text).toBe("persisted");
  });

  test("a corrupted role column is rejected on read (corruption guard)", () => {
    const session = store.createSession({ title: "t" });
    // Write a row with an out-of-allowlist role directly.
    const db = new Database(path);
    db.run(
      "INSERT INTO chat_turns (id, session_id, ts, role, text, run_id) VALUES ('bad', ?, 1, 'system', 'x', NULL)",
      [session],
    );
    db.close();
    expect(() => store.listTurns({ sessionId: session })).toThrow(StorageError);
  });
});

describe("pipeline_templates round-trip", () => {
  let path: string;
  let store: Store;

  beforeEach(() => {
    path = tempDbPath();
    store = openStore(path);
  });

  afterEach(() => {
    store.close();
    try {
      rmSync(path, { force: true });
      rmSync(`${path}-shm`, { force: true });
      rmSync(`${path}-wal`, { force: true });
    } catch {
      // ignore
    }
  });

  test("getTemplate returns null before any upsert", () => {
    expect(store.getTemplate("router")).toBeNull();
  });

  test("upsertTemplate then getTemplate round-trips prompt + default params", () => {
    store.upsertTemplate({
      handlerId: "router",
      prompt: "classify strictly",
      defaultParams: { tone: "warm", retries: 2 },
    });
    const t = store.getTemplate("router");
    expect(t).not.toBeNull();
    expect(t?.handlerId).toBe("router");
    expect(t?.prompt).toBe("classify strictly");
    expect(t?.defaultParams).toEqual({ tone: "warm", retries: 2 });
    expect(typeof t?.updatedAt).toBe("number");
  });

  test("upsertTemplate updates an existing row (ON CONFLICT)", () => {
    store.upsertTemplate({ handlerId: "router", prompt: "v1", defaultParams: {} });
    store.upsertTemplate({ handlerId: "router", prompt: "v2", defaultParams: { a: 1 } });
    const t = store.getTemplate("router");
    expect(t?.prompt).toBe("v2");
    expect(t?.defaultParams).toEqual({ a: 1 });
  });

  test("template survives reopen", () => {
    store.upsertTemplate({ handlerId: "router", prompt: "kept", defaultParams: {} });
    store.close();
    const reopened = openStore(path);
    expect(reopened.getTemplate("router")?.prompt).toBe("kept");
    reopened.close();
  });
});

describe("migration 007 — chat home", () => {
  let path: string;

  beforeEach(() => {
    path = tempDbPath();
  });

  afterEach(() => {
    try {
      rmSync(path, { force: true });
      rmSync(`${path}-shm`, { force: true });
      rmSync(`${path}-wal`, { force: true });
    } catch {
      // ignore
    }
  });

  test("schema_migrations records 007 and reopen is idempotent (chat tables queryable)", () => {
    const first = openStore(path);
    first.close();
    const second = openStore(path);
    second.close();

    const db = new Database(path, { readonly: true });
    const ids = db
      .query<{ id: string }, []>("SELECT id FROM schema_migrations")
      .all()
      .map((r) => r.id);
    expect(() => db.query("SELECT count(*) FROM chat_sessions").get()).not.toThrow();
    expect(() => db.query("SELECT count(*) FROM chat_turns").get()).not.toThrow();
    expect(() => db.query("SELECT count(*) FROM pipeline_templates").get()).not.toThrow();
    db.close();

    expect(ids).toContain("007_chat_home");
    expect(ids.filter((id) => id === "007_chat_home")).toHaveLength(1);
  });

  test("007 is sequenced AFTER 006 (forward-only ordering)", () => {
    const idx006 = MIGRATIONS.findIndex((m) => m.id.startsWith("006"));
    const idx007 = MIGRATIONS.findIndex((m) => m.id === "007_chat_home");
    expect(idx006).toBeGreaterThanOrEqual(0);
    expect(idx007).toBeGreaterThan(idx006);
  });
});

// ---------------------------------------------------------------------------
// Migration 008 — run context (forward-only)
// ---------------------------------------------------------------------------

describe("migration 008 — run context", () => {
  let path: string;

  beforeEach(() => {
    path = tempDbPath();
  });

  afterEach(() => {
    try {
      rmSync(path, { force: true });
      rmSync(`${path}-shm`, { force: true });
      rmSync(`${path}-wal`, { force: true });
    } catch {
      // ignore
    }
  });

  test("schema_migrations records 008_run_context and reopen is idempotent (ctx columns queryable)", () => {
    const first = openStore(path);
    first.close();
    const second = openStore(path);
    second.close();

    const db = new Database(path, { readonly: true });
    const ids = db
      .query<{ id: string }, []>("SELECT id FROM schema_migrations")
      .all()
      .map((r) => r.id);
    // The three new columns must exist and be queryable.
    expect(() =>
      db.query("SELECT ctx_used_tokens, ctx_limit, ctx_model FROM runs").all(),
    ).not.toThrow();
    db.close();

    expect(ids).toContain("008_run_context");
    expect(ids.filter((id) => id === "008_run_context")).toHaveLength(1);
  });

  test("008 is sequenced AFTER 007 (forward-only ordering)", () => {
    const idx007 = MIGRATIONS.findIndex((m) => m.id === "007_chat_home");
    const idx008 = MIGRATIONS.findIndex((m) => m.id === "008_run_context");
    expect(idx007).toBeGreaterThanOrEqual(0);
    expect(idx008).toBeGreaterThan(idx007);
  });

  test("a runs row written BEFORE migration 008 reads back context null", () => {
    // Apply 001..007, insert a row, then apply 008 — the new columns default to NULL.
    const db = new Database(":memory:");
    const idx008 = MIGRATIONS.findIndex((m) => m.id === "008_run_context");
    expect(idx008).toBeGreaterThan(0);

    for (const m of MIGRATIONS.slice(0, idx008)) {
      for (const stmt of statementsOf(m.sql)) db.run(stmt);
    }
    // Pre-008 row: only the original columns exist at this point.
    db.run(
      "INSERT INTO runs (id, ts, pipeline, status, summary) VALUES ('pre-008', 1000, 'p', 'ok', 'legacy')",
    );
    // Apply migration 008.
    for (const stmt of statementsOf(MIGRATIONS[idx008]?.sql ?? "")) db.run(stmt);

    const store = new SqliteStore(db);
    const runs = store.listRuns({ pipeline: "p" });
    db.close();

    expect(runs).toHaveLength(1);
    expect(runs[0]?.id).toBe("pre-008");
    expect(runs[0]?.context).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// recordRunContext
// ---------------------------------------------------------------------------

describe("recordRunContext", () => {
  let path: string;
  let store: Store;

  beforeEach(() => {
    path = tempDbPath();
    store = openStore(path);
  });

  afterEach(() => {
    store.close();
    try {
      rmSync(path, { force: true });
      rmSync(`${path}-shm`, { force: true });
      rmSync(`${path}-wal`, { force: true });
    } catch {
      // ignore
    }
  });

  test("a run with no recorded context returns context null via listRuns", () => {
    store.startRun({ pipeline: "p" });
    const runs = store.listRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0]?.context).toBeNull();
  });

  test("a run with no recorded context returns context null via runTree", () => {
    const id = store.startRun({ pipeline: "p" });
    const tree = store.runTree(id);
    expect(tree).not.toBeNull();
    expect(tree?.run.context).toBeNull();
  });

  test("recordRunContext updates the row; listRuns returns the exact context values", () => {
    const runId = store.startRun({ pipeline: "p" });
    store.recordRunContext({ runId, usedTokens: 42000, limit: 200000, model: "claude-3-5-sonnet" });

    const runs = store.listRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0]?.context).not.toBeNull();
    expect(runs[0]?.context?.usedTokens).toBe(42000);
    expect(runs[0]?.context?.limit).toBe(200000);
    expect(runs[0]?.context?.model).toBe("claude-3-5-sonnet");
  });

  test("recordRunContext with null model stores null model on the context", () => {
    const runId = store.startRun({ pipeline: "p" });
    store.recordRunContext({ runId, usedTokens: 10, limit: 200000, model: null });

    const runs = store.listRuns();
    expect(runs[0]?.context?.model).toBeNull();
    expect(runs[0]?.context?.usedTokens).toBe(10);
  });

  test("recordRunContext updates the row; runTree returns the exact context values", () => {
    const runId = store.startRun({ pipeline: "p" });
    store.recordRunContext({ runId, usedTokens: 5000, limit: 1000000, model: "claude-opus-4" });

    const tree = store.runTree(runId);
    expect(tree).not.toBeNull();
    expect(tree?.run.context?.usedTokens).toBe(5000);
    expect(tree?.run.context?.limit).toBe(1000000);
    expect(tree?.run.context?.model).toBe("claude-opus-4");
  });

  test("recordRunContext overwrites a previously recorded context (latest wins)", () => {
    const runId = store.startRun({ pipeline: "p" });
    store.recordRunContext({ runId, usedTokens: 1000, limit: 200000, model: "m1" });
    store.recordRunContext({ runId, usedTokens: 99000, limit: 200000, model: "m2" });

    const runs = store.listRuns();
    expect(runs[0]?.context?.usedTokens).toBe(99000);
    expect(runs[0]?.context?.model).toBe("m2");
  });

  test("recordRunContext on an unknown runId is a no-op (best-effort, does not throw)", () => {
    expect(() =>
      store.recordRunContext({
        runId: "does-not-exist",
        usedTokens: 1,
        limit: 200000,
        model: null,
      }),
    ).not.toThrow();
  });

  test("context survives close and reopen (durable)", () => {
    const runId = store.startRun({ pipeline: "p" });
    store.recordRunContext({ runId, usedTokens: 7777, limit: 200000, model: "persisted-model" });
    store.close();

    const reopened = openStore(path);
    const runs = reopened.listRuns();
    reopened.close();

    expect(runs[0]?.context?.usedTokens).toBe(7777);
    expect(runs[0]?.context?.model).toBe("persisted-model");
  });

  test("child run context is independent of parent run context", () => {
    const parentId = store.startRun({ pipeline: "parent" });
    const childId = store.startRun({ pipeline: "child", parentRunId: parentId });

    store.recordRunContext({ runId: parentId, usedTokens: 1000, limit: 200000, model: "big" });
    store.recordRunContext({ runId: childId, usedTokens: 500, limit: 100000, model: "small" });

    const tree = store.runTree(parentId);
    expect(tree?.run.context?.usedTokens).toBe(1000);
    expect(tree?.run.context?.model).toBe("big");
    expect(tree?.children[0]?.run.context?.usedTokens).toBe(500);
    expect(tree?.children[0]?.run.context?.model).toBe("small");
  });
});
