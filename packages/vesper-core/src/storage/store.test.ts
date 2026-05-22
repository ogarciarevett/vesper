import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StorageError } from "./errors.ts";
import { openStore, SqliteStore } from "./store.ts";
import type { Store } from "./types.ts";

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

    expect(rows).toHaveLength(1);
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

  test("migrate() called again is idempotent — schema_migrations still has exactly 1 row", () => {
    const store = openStore(path);
    // Call migrate() a second and third time — should be no-ops.
    store.migrate();
    store.migrate();
    store.close();

    const db = new Database(path, { readonly: true });
    const rows = db.query<{ id: string }, []>("SELECT id FROM schema_migrations").all();
    db.close();

    expect(rows).toHaveLength(1);
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
    store.migrate();
    store.migrate();

    const rows = db.query<{ id: string }, []>("SELECT id FROM schema_migrations").all();
    expect(rows).toHaveLength(1);

    store.close();
  });
});
