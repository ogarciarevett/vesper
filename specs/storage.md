# SPEC: storage module (DEV-87)

## Why

Vesper pipelines need a durable, local-first store to record events (what happened, from which
source, with what payload) and pipeline run records (did the run succeed, with what outcome).
Foundation commits to `bun:sqlite` — no network, no external service, no new dependency. The
storage module wraps SQLite behind typed helpers so the rest of the host runtime never writes raw
SQL, and a forward-only migration runner guarantees the schema is always up to date when the
database is opened.

## What changes

- New `packages/vesper-core/src/storage/errors.ts` — `StorageError extends VesperError`
  (code `"storage"`) with typed reasons: `"open_failed" | "migration_failed" | "query_failed"`.
  All bun:sqlite exceptions are caught and re-thrown as `StorageError`.
- New `packages/vesper-core/src/storage/types.ts` — plain TypeScript types for the public API:
  `EventRow`, `RunRow`, `AppendEventInput`, `RecordRunInput`, `ListEventsOptions`,
  `ListRunsOptions`, `Store` (interface).
- New `packages/vesper-core/src/storage/migrations.ts` — v1 migration definitions (DDL for
  `events`, `runs`, `schema_migrations`), each keyed by a unique string migration id.
- New `packages/vesper-core/src/storage/store.ts` — `SqliteStore` class implementing `Store`.
  Owns the `bun:sqlite` `Database` instance. All queries use parameterized statements exclusively.
- New `packages/vesper-core/src/storage/index.ts` — barrel exporting `openStore`, `Store`,
  `StorageError`, `StorageErrorReason`, and all public types.
- New `packages/vesper-core/src/storage/store.test.ts` — bun:test suite covering the DEV-87
  acceptance criteria.

## Design decisions

- `openStore(path)` is the single factory. It constructs `SqliteStore`, runs `migrate()`, and
  returns the store. Tests that need control over migration timing can call `migrate()` again (it
  is idempotent) or inspect the migrations table directly.
- `migrate()` is exposed on `Store` so callers can run it explicitly (e.g. `vesper init`).
  Internally it iterates the ordered migration list and inserts only the ids not yet present in
  `schema_migrations`. Wrapped in a single `BEGIN EXCLUSIVE / COMMIT` transaction so a partial
  run (error mid-way) does not leave a half-migrated state.
- `schema_migrations` table tracks applied migrations by id; `migrate()` checks this table before
  executing each DDL, making repeated calls safe with no effect.
- All queries use `db.query(sql).run/get/all` with bound positional parameters — never template
  literals that embed user input. This satisfies the SQL-injection constraint.
- Row ids are generated as `crypto.randomUUID()` (Bun's built-in Web Crypto). Timestamps are
  `Date.now()` (milliseconds since epoch, stored as INTEGER).
- `payload` in `appendEvent` is typed `Record<string, unknown>` and serialized to `payload_json`
  via `JSON.stringify`. `listEvents` deserializes back; the column type is `TEXT NOT NULL`.
- `Store` is synchronous internally (`bun:sqlite` is synchronous) but the public interface is
  also synchronous (no Promises) — matching SQLite's nature and keeping the API simple.
  Note: this deviates from the `Vault` async pattern because SQLite I/O in Bun is always
  synchronous; wrapping in Promises would mislead callers.
- `SqliteStore` uses WAL journal mode for better concurrency and `foreign_keys = ON` pragma.
- No rollback support, no schema downgrades — forward-only for Foundation.

## Out of scope (deferred)

- sqlite-vec embedding index (deferred to Scheduler).
- Conversations / audit_log tables (deferred to Scheduler).
- Schema rollbacks / down-migrations.
- Database encryption at rest.
- Multi-process concurrent write access beyond WAL.
- Any LLM provider integration.

## Acceptance (SHALL)

- GIVEN a fresh file path WHEN `openStore(path)` THEN the file is created, `schema_migrations`
  contains exactly one row with the v1 migration id, and the `events` and `runs` tables exist.
- GIVEN a store already opened and migrated WHEN `migrate()` is called again THEN it is a no-op
  (row count in `schema_migrations` remains 1, no error thrown).
- GIVEN `appendEvent({ source: "test", kind: "ping", payload: { x: 1 } })` WHEN the store is
  closed and reopened at the same path THEN `listEvents()` returns a row with the original
  source, kind, and payload.
- GIVEN `recordRun({ pipeline: "career", status: "ok", summary: "done" })` WHEN the store is
  closed and reopened THEN `listRuns()` returns a row with matching fields.
- GIVEN a user input string containing `DROP TABLE runs` passed as an `appendEvent` source param
  WHEN `listRuns()` is called after THEN the `runs` table still exists and its row count is
  unchanged (parameterized queries prevent injection).
- `bun test` with `--coverage` reports >=80% line coverage on `storage/`.
