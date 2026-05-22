/**
 * Scheduler capability enforcement tests (DEV-109).
 *
 * Verifies:
 * - A task requiring an ungranted capability is REFUSED before execution.
 * - manual run() throws CapabilityError(reason "denied"); handler does NOT run.
 * - Scheduled tick records the denial in last_error and disables the task; handler does NOT run.
 * - A task whose required capabilities are all granted runs normally.
 * - Deny-by-default: empty grants refuse any capability-requiring task.
 * - A task with no required_capabilities runs regardless of grants.
 * - required_capabilities round-trip through persistence.
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { CapabilityError } from "../capabilities/errors.ts";
import { SqliteStore } from "../storage/store.ts";
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

function fakeClock(date: Date): () => Date {
  return () => date;
}

const MATCH_DATE = new Date(2025, 0, 15, 9, 30, 0, 0);

// ---------------------------------------------------------------------------
// Task with no required_capabilities — unaffected by grants
// ---------------------------------------------------------------------------

describe("Capability enforcement — no required_capabilities", () => {
  let db: Database;
  let registry: HandlerRegistry;

  beforeEach(() => {
    db = makeDb();
    registry = new HandlerRegistry();
  });

  afterEach(() => {
    db.close();
  });

  test("runs normally with empty grants when no capabilities required", async () => {
    let ran = false;
    registry.register("noop", () => {
      ran = true;
    });

    // grants is empty — but task has no required caps, so it should run.
    const scheduler = new Scheduler({ db, registry, clock: fakeClock(MATCH_DATE), grants: [] });
    scheduler.register({
      id: "no-cap-task",
      kind: "cron",
      schedule_expr: "30 9 15 1 3",
      handler_id: "noop",
    });

    await scheduler.tick(MATCH_DATE);
    expect(ran).toBe(true);
  });

  test("runs normally with unrelated grants when no capabilities required", async () => {
    let ran = false;
    registry.register("noop", () => {
      ran = true;
    });

    const scheduler = new Scheduler({
      db,
      registry,
      clock: fakeClock(MATCH_DATE),
      grants: ["READ_VAULT", "FS_READ"],
    });
    scheduler.register({
      id: "no-cap-task2",
      kind: "manual",
      schedule_expr: "",
      handler_id: "noop",
    });

    await scheduler.run("no-cap-task2");
    expect(ran).toBe(true);
  });

  test("empty required_capabilities defaults when not specified in RegisterTaskInput", async () => {
    registry.register("noop", () => {});
    const scheduler = new Scheduler({ db, registry, grants: [] });
    scheduler.register({ id: "bare", kind: "manual", schedule_expr: "", handler_id: "noop" });

    const task = scheduler.list()[0];
    expect(task?.required_capabilities).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Deny-by-default: empty grants refuse capability-requiring tasks
// ---------------------------------------------------------------------------

describe("Capability enforcement — deny-by-default", () => {
  let db: Database;
  let registry: HandlerRegistry;

  beforeEach(() => {
    db = makeDb();
    registry = new HandlerRegistry();
  });

  afterEach(() => {
    db.close();
  });

  test("manual run throws CapabilityError when grants is empty and cap is required", async () => {
    let ran = false;
    registry.register("noop", () => {
      ran = true;
    });

    const scheduler = new Scheduler({ db, registry, grants: [] });
    scheduler.register({
      id: "cap-task",
      kind: "manual",
      schedule_expr: "",
      handler_id: "noop",
      required_capabilities: ["READ_VAULT"],
    });

    const error = await scheduler.run("cap-task").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CapabilityError);
    expect((error as CapabilityError).reason).toBe("denied");
    expect(ran).toBe(false);
  });

  test("scheduled tick records denial and disables task when grants is empty", async () => {
    let ran = false;
    registry.register("noop", () => {
      ran = true;
    });

    const scheduler = new Scheduler({
      db,
      registry,
      clock: fakeClock(MATCH_DATE),
      grants: [],
    });
    scheduler.register({
      id: "sched-cap-task",
      kind: "cron",
      schedule_expr: "30 9 15 1 3",
      handler_id: "noop",
      required_capabilities: ["WRITE_VAULT"],
    });

    await scheduler.tick(MATCH_DATE);

    expect(ran).toBe(false);

    const task = scheduler.list()[0];
    expect(task?.enabled).toBe(false);
    expect(task?.last_error).toContain("WRITE_VAULT");
    expect(task?.last_run_at).toBe(MATCH_DATE.getTime());
  });

  test("scheduler with no grants option also denies capability-requiring tasks", async () => {
    let ran = false;
    registry.register("noop", () => {
      ran = true;
    });

    // No grants option at all (defaults to [])
    const scheduler = new Scheduler({ db, registry });
    scheduler.register({
      id: "default-deny-task",
      kind: "manual",
      schedule_expr: "",
      handler_id: "noop",
      required_capabilities: ["FS_WRITE"],
    });

    const error = await scheduler.run("default-deny-task").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CapabilityError);
    expect(ran).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Granted capabilities allow tasks to run
// ---------------------------------------------------------------------------

describe("Capability enforcement — granted capabilities", () => {
  let db: Database;
  let registry: HandlerRegistry;

  beforeEach(() => {
    db = makeDb();
    registry = new HandlerRegistry();
  });

  afterEach(() => {
    db.close();
  });

  test("manual run succeeds when all required caps are granted", async () => {
    let ran = false;
    registry.register("noop", () => {
      ran = true;
    });

    const scheduler = new Scheduler({
      db,
      registry,
      grants: ["READ_VAULT", "FS_READ"],
    });
    scheduler.register({
      id: "allowed-task",
      kind: "manual",
      schedule_expr: "",
      handler_id: "noop",
      required_capabilities: ["READ_VAULT"],
    });

    await scheduler.run("allowed-task");
    expect(ran).toBe(true);
  });

  test("scheduled tick runs task when all required caps are granted", async () => {
    let ran = false;
    registry.register("noop", () => {
      ran = true;
    });

    const scheduler = new Scheduler({
      db,
      registry,
      clock: fakeClock(MATCH_DATE),
      grants: ["CLI_INVOKE", "NETWORK_FETCH"],
    });
    scheduler.register({
      id: "granted-task",
      kind: "cron",
      schedule_expr: "30 9 15 1 3",
      handler_id: "noop",
      required_capabilities: ["CLI_INVOKE"],
    });

    await scheduler.tick(MATCH_DATE);
    expect(ran).toBe(true);

    const task = scheduler.list()[0];
    expect(task?.last_error).toBeNull();
    expect(task?.enabled).toBe(true);
  });

  test("multiple required caps — all granted — task runs", async () => {
    let ran = false;
    registry.register("noop", () => {
      ran = true;
    });

    const scheduler = new Scheduler({
      db,
      registry,
      grants: ["READ_VAULT", "WRITE_STORAGE", "FS_READ"],
    });
    scheduler.register({
      id: "multi-cap-task",
      kind: "manual",
      schedule_expr: "",
      handler_id: "noop",
      required_capabilities: ["READ_VAULT", "WRITE_STORAGE"],
    });

    await scheduler.run("multi-cap-task");
    expect(ran).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Partial denial — some caps granted, some denied
// ---------------------------------------------------------------------------

describe("Capability enforcement — partial denial", () => {
  let db: Database;
  let registry: HandlerRegistry;

  beforeEach(() => {
    db = makeDb();
    registry = new HandlerRegistry();
  });

  afterEach(() => {
    db.close();
  });

  test("throws CapabilityError listing only the denied capabilities", async () => {
    registry.register("noop", () => {});

    const scheduler = new Scheduler({
      db,
      registry,
      grants: ["READ_VAULT"],
    });
    scheduler.register({
      id: "partial-deny",
      kind: "manual",
      schedule_expr: "",
      handler_id: "noop",
      required_capabilities: ["READ_VAULT", "WRITE_VAULT"],
    });

    const error = await scheduler.run("partial-deny").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CapabilityError);
    const err = error as CapabilityError;
    expect(err.message).toContain("WRITE_VAULT");
    expect(err.message).not.toContain("READ_VAULT");
  });
});

// ---------------------------------------------------------------------------
// Capability denial does NOT trigger backoff/dead-letter on scheduled tasks
// ---------------------------------------------------------------------------

describe("Capability enforcement — denial does not trigger backoff", () => {
  let db: Database;
  let registry: HandlerRegistry;

  beforeEach(() => {
    db = makeDb();
    registry = new HandlerRegistry();
  });

  afterEach(() => {
    db.close();
  });

  test("denied scheduled task is disabled but attempt_count stays at 0", async () => {
    registry.register("noop", () => {});

    const scheduler = new Scheduler({
      db,
      registry,
      clock: fakeClock(MATCH_DATE),
      grants: [],
    });
    scheduler.register({
      id: "deny-no-backoff",
      kind: "cron",
      schedule_expr: "30 9 15 1 3",
      handler_id: "noop",
      required_capabilities: ["NETWORK_FETCH"],
    });

    await scheduler.tick(MATCH_DATE);

    const task = scheduler.list()[0];
    expect(task?.enabled).toBe(false);
    expect(task?.attempt_count).toBe(0); // no backoff increment
    expect(task?.next_attempt_at).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Persistence round-trip for required_capabilities
// ---------------------------------------------------------------------------

describe("Persistence — required_capabilities round-trip", () => {
  test("required_capabilities are persisted and loaded correctly", () => {
    const db = makeDb();
    const registry = new HandlerRegistry();
    registry.register("noop", () => {});

    const scheduler = new Scheduler({ db, registry });
    scheduler.register({
      id: "persist-caps",
      kind: "manual",
      schedule_expr: "",
      handler_id: "noop",
      required_capabilities: ["READ_VAULT", "FS_WRITE"],
    });

    // Reload from same DB.
    const s2 = new Scheduler({ db, registry });
    const task = s2.list()[0];

    expect(task?.required_capabilities).toEqual(["READ_VAULT", "FS_WRITE"]);

    db.close();
  });

  test("task with no required_capabilities stores and loads as empty array", () => {
    const db = makeDb();
    const registry = new HandlerRegistry();
    registry.register("noop", () => {});

    const scheduler = new Scheduler({ db, registry });
    scheduler.register({ id: "no-caps", kind: "manual", schedule_expr: "", handler_id: "noop" });

    const s2 = new Scheduler({ db, registry });
    const task = s2.list()[0];

    expect(task?.required_capabilities).toEqual([]);

    db.close();
  });
});

// ---------------------------------------------------------------------------
// tick() isolates capability denial (does not stop other tasks)
// ---------------------------------------------------------------------------

describe("Capability enforcement — tick isolation", () => {
  test("tick isolates capability denial: other tasks still run", async () => {
    const db = makeDb();
    const registry = new HandlerRegistry();
    let okRan = false;
    registry.register("denied-handler", () => {});
    registry.register("ok-handler", () => {
      okRan = true;
    });

    const scheduler = new Scheduler({
      db,
      registry,
      clock: fakeClock(MATCH_DATE),
      grants: ["FS_READ"], // only FS_READ granted
    });

    scheduler.register({
      id: "needs-network",
      kind: "cron",
      schedule_expr: "30 9 15 1 3",
      handler_id: "denied-handler",
      required_capabilities: ["NETWORK_FETCH"], // not granted
    });

    scheduler.register({
      id: "needs-fs-read",
      kind: "cron",
      schedule_expr: "30 9 15 1 3",
      handler_id: "ok-handler",
      required_capabilities: ["FS_READ"], // granted
    });

    await scheduler.tick(MATCH_DATE);

    expect(okRan).toBe(true);

    const tasks = scheduler.list();
    const denied = tasks.find((t) => t.id === "needs-network");
    const granted = tasks.find((t) => t.id === "needs-fs-read");

    expect(denied?.enabled).toBe(false);
    expect(denied?.last_error).toContain("NETWORK_FETCH");
    expect(granted?.enabled).toBe(true);
    expect(granted?.last_error).toBeNull();

    db.close();
  });
});
