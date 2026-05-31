/**
 * Per-task capability grant tests (migration 005, Forge Slice 1).
 *
 * The host union (`grants`, from `grantedCapabilities()`) is the ABSOLUTE
 * CEILING — a task can never exceed what installed pipelines declared. The
 * per-task grant row (`task_grants`) is the tightening that actually gates
 * execution: a task is denied a capability it does not hold in its own grant
 * row even when the host union still contains it.
 *
 * Verified here:
 * - register() writes a grant row equal to the declared required_capabilities.
 * - The per-task grant (not the union) gates execution — shrinking it to []
 *   denies a task whose cap is still in the host union.
 * - Deny-by-default: a task with no grant row is denied (getTaskGrant => null).
 * - Ceiling refusal: register() throws grant_exceeds_ceiling and persists
 *   NOTHING when required caps are not a subset of the host union.
 * - Built-in parity: grant == required_capabilities; re-registration (the
 *   daemon-restart path) backfills the grant for an already-persisted task.
 * - SPAWN_SUBAGENT is deny-by-default end to end.
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { CapabilityError } from "../capabilities/errors.ts";
import { SqliteStore } from "../storage/store.ts";
import { SchedulerError } from "./errors.ts";
import { HandlerRegistry } from "./registry.ts";
import { Scheduler } from "./scheduler.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDb(): Database {
  const db = new Database(":memory:");
  const store = new SqliteStore(db);
  store.migrate();
  return db;
}

// ---------------------------------------------------------------------------
// register() writes the per-task grant; it equals required_capabilities
// ---------------------------------------------------------------------------

describe("Per-task grant — written at register()", () => {
  let db: Database;
  let registry: HandlerRegistry;

  beforeEach(() => {
    db = makeDb();
    registry = new HandlerRegistry();
  });

  afterEach(() => {
    db.close();
  });

  test("grant row equals declared required_capabilities (built-in parity)", () => {
    registry.register("handler-x", () => {});
    const scheduler = new Scheduler({
      db,
      registry,
      grants: ["READ_VAULT", "WRITE_STORAGE"],
    });
    scheduler.register({
      id: "t",
      kind: "manual",
      schedule_expr: "",
      handler_id: "handler-x",
      required_capabilities: ["READ_VAULT", "WRITE_STORAGE"],
    });

    const store = new SqliteStore(db);
    const grant = store.getTaskGrant("handler-x");
    expect(grant?.capabilities).toEqual(["READ_VAULT", "WRITE_STORAGE"]);
    expect(grant?.granted_by).toBe("register");
  });

  test("a task is granted only its own caps, not the host union (A cannot inherit B's cap)", () => {
    registry.register("handler-a", () => {});
    registry.register("handler-b", () => {});

    // Host union spans both caps, but each task only declares one.
    const scheduler = new Scheduler({
      db,
      registry,
      grants: ["CLI_INVOKE", "FS_WRITE"],
    });
    scheduler.register({
      id: "task-a",
      kind: "manual",
      schedule_expr: "",
      handler_id: "handler-a",
      required_capabilities: ["CLI_INVOKE"],
    });
    scheduler.register({
      id: "task-b",
      kind: "manual",
      schedule_expr: "",
      handler_id: "handler-b",
      required_capabilities: ["FS_WRITE"],
    });

    const store = new SqliteStore(db);
    const grantA = store.getTaskGrant("handler-a");
    expect(grantA?.capabilities).toEqual(["CLI_INVOKE"]);
    expect(grantA?.capabilities).not.toContain("FS_WRITE");
  });

  test("a task with no required_capabilities writes an empty grant row", () => {
    registry.register("h-bare", () => {});
    const scheduler = new Scheduler({ db, registry, grants: [] });
    scheduler.register({ id: "bare", kind: "manual", schedule_expr: "", handler_id: "h-bare" });

    const store = new SqliteStore(db);
    expect(store.getTaskGrant("h-bare")?.capabilities).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The per-task grant — not the union — gates execution
// ---------------------------------------------------------------------------

describe("Per-task grant — gates execution", () => {
  let db: Database;
  let registry: HandlerRegistry;

  beforeEach(() => {
    db = makeDb();
    registry = new HandlerRegistry();
  });

  afterEach(() => {
    db.close();
  });

  test("shrinking the grant to [] denies a manual run even though the union still grants the cap", async () => {
    let ran = false;
    registry.register("handler-a", () => {
      ran = true;
    });

    const scheduler = new Scheduler({ db, registry, grants: ["CLI_INVOKE"] });
    scheduler.register({
      id: "task-a",
      kind: "manual",
      schedule_expr: "",
      handler_id: "handler-a",
      required_capabilities: ["CLI_INVOKE"],
    });

    // Directly shrink the per-task grant to [] (forge revoke / tightening).
    const store = new SqliteStore(db);
    store.upsertTaskGrant({ handler_id: "handler-a", capabilities: [], granted_by: "test" });

    // Fresh scheduler against the SAME db — host union still contains CLI_INVOKE,
    // but the per-task grant is now empty, so execution must be denied.
    const s2 = new Scheduler({ db, registry, grants: ["CLI_INVOKE"] });
    const error = await s2.run("task-a").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CapabilityError);
    expect((error as CapabilityError).reason).toBe("denied");
    expect(ran).toBe(false);
  });

  test("a task whose grant matches its required caps runs", async () => {
    let ran = false;
    registry.register("handler-a", () => {
      ran = true;
    });

    const scheduler = new Scheduler({ db, registry, grants: ["CLI_INVOKE"] });
    scheduler.register({
      id: "task-a",
      kind: "manual",
      schedule_expr: "",
      handler_id: "handler-a",
      required_capabilities: ["CLI_INVOKE"],
    });

    await scheduler.run("task-a");
    expect(ran).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Deny-by-default: no grant row => denied
// ---------------------------------------------------------------------------

describe("Per-task grant — deny-by-default for ungranted task rows", () => {
  let db: Database;
  let registry: HandlerRegistry;

  beforeEach(() => {
    db = makeDb();
    registry = new HandlerRegistry();
  });

  afterEach(() => {
    db.close();
  });

  test("a persisted task with no task_grants row is denied (getTaskGrant => null)", async () => {
    let ran = false;
    registry.register("handler-a", () => {
      ran = true;
    });

    const scheduler = new Scheduler({ db, registry, grants: ["READ_VAULT"] });
    scheduler.register({
      id: "task-a",
      kind: "manual",
      schedule_expr: "",
      handler_id: "handler-a",
      required_capabilities: ["READ_VAULT"],
    });

    // Delete the grant row directly, simulating a pre-005 / ungranted task row.
    db.query<void, [string]>("DELETE FROM task_grants WHERE handler_id = ?").run("handler-a");
    const store = new SqliteStore(db);
    expect(store.getTaskGrant("handler-a")).toBeNull();

    const s2 = new Scheduler({ db, registry, grants: ["READ_VAULT"] });
    const error = await s2.run("task-a").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CapabilityError);
    expect((error as CapabilityError).reason).toBe("denied");
    expect(ran).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Ceiling refusal: required caps must be a subset of the host union
// ---------------------------------------------------------------------------

describe("Per-task grant — ceiling refusal at register()", () => {
  let db: Database;
  let registry: HandlerRegistry;

  beforeEach(() => {
    db = makeDb();
    registry = new HandlerRegistry();
  });

  afterEach(() => {
    db.close();
  });

  test("register() throws grant_exceeds_ceiling and persists nothing", () => {
    registry.register("handler-a", () => {});
    const scheduler = new Scheduler({ db, registry, grants: ["READ_VAULT"] });

    let thrown: unknown;
    try {
      scheduler.register({
        id: "task-a",
        kind: "manual",
        schedule_expr: "",
        handler_id: "handler-a",
        required_capabilities: ["READ_VAULT", "FS_WRITE"],
      });
    } catch (e: unknown) {
      thrown = e;
    }

    expect(thrown).toBeInstanceOf(SchedulerError);
    expect((thrown as SchedulerError).reason).toBe("grant_exceeds_ceiling");

    // No scheduled_tasks row and no task_grants row were written.
    expect(scheduler.list()).toHaveLength(0);
    const store = new SqliteStore(db);
    expect(store.getTaskGrant("handler-a")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Daemon-restart backfill: re-registration upserts the grant for an existing task
// ---------------------------------------------------------------------------

describe("Per-task grant — re-registration backfills the grant", () => {
  let db: Database;
  let registry: HandlerRegistry;

  beforeEach(() => {
    db = makeDb();
    registry = new HandlerRegistry();
  });

  afterEach(() => {
    db.close();
  });

  test("registering a task twice keeps the grant present and the task runnable", async () => {
    let runs = 0;
    registry.register("handler-a", () => {
      runs += 1;
    });

    const scheduler = new Scheduler({ db, registry, grants: ["READ_VAULT"] });
    const input = {
      id: "task-a",
      kind: "manual" as const,
      schedule_expr: "",
      handler_id: "handler-a",
      required_capabilities: ["READ_VAULT"] as const,
    };
    scheduler.register(input);

    // Simulate a pre-existing task whose grant was never written (pre-005 row).
    db.query<void, [string]>("DELETE FROM task_grants WHERE handler_id = ?").run("handler-a");

    // Second register() (the daemon-restart path through registerPipelines) must
    // backfill the grant even though the scheduled_tasks row already exists.
    const error = (() => {
      try {
        scheduler.register(input);
        return null;
      } catch (e: unknown) {
        return e;
      }
    })();
    // The duplicate is surfaced as duplicate_task (registerPipelines swallows it),
    // but the grant must have been backfilled before/despite that throw.
    if (error !== null) {
      expect(error).toBeInstanceOf(SchedulerError);
      expect((error as SchedulerError).reason).toBe("duplicate_task");
    }

    const store = new SqliteStore(db);
    expect(store.getTaskGrant("handler-a")?.capabilities).toEqual(["READ_VAULT"]);

    await scheduler.run("task-a");
    expect(runs).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// SPAWN_SUBAGENT is deny-by-default end to end
// ---------------------------------------------------------------------------

describe("Per-task grant — SPAWN_SUBAGENT deny-by-default", () => {
  let db: Database;
  let registry: HandlerRegistry;

  beforeEach(() => {
    db = makeDb();
    registry = new HandlerRegistry();
  });

  afterEach(() => {
    db.close();
  });

  test("register() refuses SPAWN_SUBAGENT when not in the host union", () => {
    registry.register("handler-a", () => {});
    const scheduler = new Scheduler({ db, registry, grants: ["CLI_INVOKE"] });

    let thrown: unknown;
    try {
      scheduler.register({
        id: "task-a",
        kind: "manual",
        schedule_expr: "",
        handler_id: "handler-a",
        required_capabilities: ["SPAWN_SUBAGENT"],
      });
    } catch (e: unknown) {
      thrown = e;
    }

    expect(thrown).toBeInstanceOf(SchedulerError);
    expect((thrown as SchedulerError).reason).toBe("grant_exceeds_ceiling");
  });

  test("even with SPAWN_SUBAGENT in the union, an emptied grant denies the run", async () => {
    let ran = false;
    registry.register("handler-a", () => {
      ran = true;
    });

    const scheduler = new Scheduler({ db, registry, grants: ["SPAWN_SUBAGENT"] });
    scheduler.register({
      id: "task-a",
      kind: "manual",
      schedule_expr: "",
      handler_id: "handler-a",
      required_capabilities: ["SPAWN_SUBAGENT"],
    });

    const store = new SqliteStore(db);
    store.upsertTaskGrant({ handler_id: "handler-a", capabilities: [], granted_by: "test" });

    const s2 = new Scheduler({ db, registry, grants: ["SPAWN_SUBAGENT"] });
    const error = await s2.run("task-a").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CapabilityError);
    expect(ran).toBe(false);
  });
});
