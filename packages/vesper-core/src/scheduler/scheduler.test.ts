import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { SqliteStore } from "../storage/store.ts";
import { SchedulerError } from "./errors.ts";
import { EventBus } from "./events.ts";
import { TaskPersistence } from "./persistence.ts";
import { HandlerRegistry } from "./registry.ts";
import { Scheduler } from "./scheduler.ts";
import type { TaskContext } from "./types.ts";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Open an in-memory database with all migrations applied. */
function makeDb(): Database {
  const db = new Database(":memory:");
  const store = new SqliteStore(db);
  store.migrate();
  // Return the raw Database so Scheduler can use it directly.
  return db;
}

/** A deterministic fake clock returning the given date. */
function fakeClock(date: Date): () => Date {
  return () => date;
}

// A date that matches "30 9 15 1 3" (Jan 15 2025 09:30 Wednesday)
const MATCH_DATE = new Date(2025, 0, 15, 9, 30, 0, 0);
// A date that does NOT match "30 9 15 1 3"
const NO_MATCH_DATE = new Date(2025, 0, 15, 10, 0, 0, 0);

// ---------------------------------------------------------------------------
// Cron task fires on tick
// ---------------------------------------------------------------------------

describe("Scheduler — cron tasks", () => {
  let db: Database;
  let registry: HandlerRegistry;

  beforeEach(() => {
    db = makeDb();
    registry = new HandlerRegistry();
  });

  afterEach(() => {
    db.close();
  });

  test("GIVEN cron task WHEN tick(matchingDate) THEN handler runs and last_run_at is set", async () => {
    let ran = false;
    registry.register("noop", () => {
      ran = true;
    });

    const scheduler = new Scheduler({
      db,
      registry,
      clock: fakeClock(MATCH_DATE),
    });

    scheduler.register({
      id: "cron-task",
      kind: "cron",
      schedule_expr: "30 9 15 1 3",
      handler_id: "noop",
    });

    await scheduler.tick(MATCH_DATE);

    expect(ran).toBe(true);

    const tasks = scheduler.list();
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.last_run_at).toBe(MATCH_DATE.getTime());
    expect(tasks[0]?.last_error).toBeNull();
  });

  test("GIVEN cron task WHEN tick(nonMatchingDate) THEN handler does NOT run", async () => {
    let ran = false;
    registry.register("noop", () => {
      ran = true;
    });

    const scheduler = new Scheduler({ db, registry });

    scheduler.register({
      id: "cron-task",
      kind: "cron",
      schedule_expr: "30 9 15 1 3",
      handler_id: "noop",
    });

    await scheduler.tick(NO_MATCH_DATE);

    expect(ran).toBe(false);
    const tasks = scheduler.list();
    expect(tasks[0]?.last_run_at).toBeNull();
  });

  test("GIVEN disabled cron task WHEN tick(matchingDate) THEN handler does NOT run", async () => {
    let ran = false;
    registry.register("noop", () => {
      ran = true;
    });

    const scheduler = new Scheduler({ db, registry });

    scheduler.register({
      id: "cron-task",
      kind: "cron",
      schedule_expr: "30 9 15 1 3",
      handler_id: "noop",
      enabled: false,
    });

    await scheduler.tick(MATCH_DATE);

    expect(ran).toBe(false);
  });

  test("handler receives correct task and now in context", async () => {
    let capturedCtx: TaskContext | undefined;
    registry.register("spy", (ctx) => {
      capturedCtx = ctx;
    });

    const scheduler = new Scheduler({
      db,
      registry,
      clock: fakeClock(MATCH_DATE),
    });

    scheduler.register({
      id: "ctx-task",
      kind: "cron",
      schedule_expr: "30 9 15 1 3",
      handler_id: "spy",
    });

    await scheduler.tick(MATCH_DATE);

    expect(capturedCtx).toBeDefined();
    expect(capturedCtx?.task.id).toBe("ctx-task");
    expect(capturedCtx?.now).toEqual(MATCH_DATE);
  });

  test("handler error in tick is recorded in last_error and isolated (tick does not throw)", async () => {
    registry.register("failing", () => {
      throw new Error("boom");
    });

    const scheduler = new Scheduler({
      db,
      registry,
      clock: fakeClock(MATCH_DATE),
    });

    scheduler.register({
      id: "fail-task",
      kind: "cron",
      schedule_expr: "30 9 15 1 3",
      handler_id: "failing",
    });

    // tick isolates per-task failures: it does NOT throw; the error is recorded.
    await scheduler.tick(MATCH_DATE);

    const tasks = scheduler.list();
    expect(tasks[0]?.last_error).toBe("boom");
    expect(tasks[0]?.last_run_at).toBe(MATCH_DATE.getTime());
  });

  test("one failing cron task does not prevent another due task from running", async () => {
    let okRan = false;
    registry.register("failing", () => {
      throw new Error("boom");
    });
    registry.register("ok", () => {
      okRan = true;
    });

    const scheduler = new Scheduler({ db, registry, clock: fakeClock(MATCH_DATE) });
    scheduler.register({
      id: "f",
      kind: "cron",
      schedule_expr: "30 9 15 1 3",
      handler_id: "failing",
    });
    scheduler.register({ id: "g", kind: "cron", schedule_expr: "30 9 15 1 3", handler_id: "ok" });

    await scheduler.tick(MATCH_DATE);

    expect(okRan).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Event tasks
// ---------------------------------------------------------------------------

describe("Scheduler — event tasks", () => {
  let db: Database;
  let registry: HandlerRegistry;
  let bus: EventBus;

  beforeEach(() => {
    db = makeDb();
    registry = new HandlerRegistry();
    bus = new EventBus();
  });

  afterEach(() => {
    db.close();
  });

  test("GIVEN event task WHEN topic is emitted THEN handler runs", async () => {
    let ran = false;
    registry.register("noop", () => {
      ran = true;
    });

    const scheduler = new Scheduler({ db, registry, events: bus });

    scheduler.register({
      id: "evt-task",
      kind: "event",
      schedule_expr: "user.signup",
      handler_id: "noop",
    });

    bus.emit("user.signup");

    // Allow microtask queue to drain (fire-and-forget in event listener).
    await new Promise<void>((resolve) => setTimeout(resolve, 10));

    expect(ran).toBe(true);
  });

  test("GIVEN event task WHEN different topic is emitted THEN handler does NOT run", async () => {
    let ran = false;
    registry.register("noop", () => {
      ran = true;
    });

    const scheduler = new Scheduler({ db, registry, events: bus });

    scheduler.register({
      id: "evt-task",
      kind: "event",
      schedule_expr: "user.signup",
      handler_id: "noop",
    });

    bus.emit("user.logout");

    await new Promise<void>((resolve) => setTimeout(resolve, 10));

    expect(ran).toBe(false);
  });

  test("GIVEN event task WHEN unregistered THEN handler no longer runs on emit", async () => {
    let callCount = 0;
    registry.register("counter", () => {
      callCount++;
    });

    const scheduler = new Scheduler({ db, registry, events: bus });

    scheduler.register({
      id: "evt-task",
      kind: "event",
      schedule_expr: "topic.x",
      handler_id: "counter",
    });

    scheduler.unregister("evt-task");

    bus.emit("topic.x");
    await new Promise<void>((resolve) => setTimeout(resolve, 10));

    expect(callCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Manual run
// ---------------------------------------------------------------------------

describe("Scheduler — manual run", () => {
  let db: Database;
  let registry: HandlerRegistry;

  beforeEach(() => {
    db = makeDb();
    registry = new HandlerRegistry();
  });

  afterEach(() => {
    db.close();
  });

  test("run(id) executes the handler once and records last_run_at", async () => {
    let ran = false;
    registry.register("noop", () => {
      ran = true;
    });

    const now = new Date(2025, 5, 1, 12, 0, 0, 0);
    const scheduler = new Scheduler({ db, registry, clock: fakeClock(now) });

    scheduler.register({
      id: "manual-task",
      kind: "manual",
      schedule_expr: "",
      handler_id: "noop",
    });

    await scheduler.run("manual-task");

    expect(ran).toBe(true);
    const tasks = scheduler.list();
    expect(tasks[0]?.last_run_at).toBe(now.getTime());
    expect(tasks[0]?.last_error).toBeNull();
  });

  test("run(unknownId) throws SchedulerError(unknown_task)", async () => {
    const scheduler = new Scheduler({ db, registry });

    await expect(scheduler.run("no-such-task")).rejects.toBeInstanceOf(SchedulerError);
    try {
      await scheduler.run("no-such-task");
    } catch (e: unknown) {
      expect(e).toBeInstanceOf(SchedulerError);
      expect((e as SchedulerError).reason).toBe("unknown_task");
    }
  });

  test("async handler is awaited correctly", async () => {
    let resolved = false;
    registry.register("async-handler", async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
      resolved = true;
    });

    const scheduler = new Scheduler({ db, registry });

    scheduler.register({
      id: "async-task",
      kind: "manual",
      schedule_expr: "",
      handler_id: "async-handler",
    });

    await scheduler.run("async-task");
    expect(resolved).toBe(true);
  });

  test("run() with a failing handler re-throws the original error and records last_error", async () => {
    registry.register("failing", () => {
      throw new Error("kaboom");
    });
    const now = new Date(2025, 5, 1, 12, 0, 0, 0);
    const scheduler = new Scheduler({ db, registry, clock: fakeClock(now) });
    scheduler.register({ id: "m", kind: "manual", schedule_expr: "", handler_id: "failing" });

    await expect(scheduler.run("m")).rejects.toThrow("kaboom");
    expect(scheduler.list()[0]?.last_error).toBe("kaboom");
  });
});

// ---------------------------------------------------------------------------
// Persistence — tasks survive restart
// ---------------------------------------------------------------------------

describe("Scheduler — persistence across restarts", () => {
  let db: Database;
  let registry: HandlerRegistry;

  beforeEach(() => {
    db = makeDb();
    registry = new HandlerRegistry();
    registry.register("noop", () => {});
  });

  afterEach(() => {
    db.close();
  });

  test("GIVEN registered task WHEN new Scheduler from same db THEN task is loaded", () => {
    const s1 = new Scheduler({ db, registry });
    s1.register({
      id: "persisted-task",
      kind: "cron",
      schedule_expr: "0 * * * *",
      handler_id: "noop",
    });

    // Construct a new Scheduler with the same DB — simulates a restart.
    const s2 = new Scheduler({ db, registry });

    const tasks = s2.list();
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.id).toBe("persisted-task");
    expect(tasks[0]?.kind).toBe("cron");
    expect(tasks[0]?.schedule_expr).toBe("0 * * * *");
    expect(tasks[0]?.handler_id).toBe("noop");
    expect(tasks[0]?.enabled).toBe(true);
    expect(tasks[0]?.last_run_at).toBeNull();
    expect(tasks[0]?.last_error).toBeNull();
  });

  test("GIVEN event task on restart WHEN topic emitted THEN handler runs", async () => {
    const bus = new EventBus();
    let ran = false;
    registry.register("event-handler", () => {
      ran = true;
    });

    // Register in first scheduler instance.
    const s1 = new Scheduler({ db, registry, events: bus });
    s1.register({
      id: "restart-evt-task",
      kind: "event",
      schedule_expr: "some.topic",
      handler_id: "event-handler",
    });

    // Create second scheduler (same db, same bus) — should re-subscribe.
    const s2 = new Scheduler({ db, registry, events: bus });

    // Clear s1 subscription to avoid double-run (simulate true restart isolation).
    // In a real restart the old instance is gone. Here we avoid the s1 listener by
    // removing it manually. Instead we just use a fresh bus for s2.
    const freshBus = new EventBus();
    const s3 = new Scheduler({ db, registry, events: freshBus });
    void s2; // s2 verified tasks are loaded; s3 tests re-subscription
    const tasks3 = s3.list();
    expect(tasks3).toHaveLength(1);

    freshBus.emit("some.topic");
    await new Promise<void>((resolve) => setTimeout(resolve, 10));

    expect(ran).toBe(true);
  });

  test("unregister removes task from persistence", () => {
    const s1 = new Scheduler({ db, registry });
    s1.register({ id: "to-remove", kind: "manual", schedule_expr: "", handler_id: "noop" });
    s1.unregister("to-remove");

    const s2 = new Scheduler({ db, registry });
    expect(s2.list()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Error scenarios
// ---------------------------------------------------------------------------

describe("Scheduler — error scenarios", () => {
  let db: Database;
  let registry: HandlerRegistry;

  beforeEach(() => {
    db = makeDb();
    registry = new HandlerRegistry();
  });

  afterEach(() => {
    db.close();
  });

  test("duplicate_task error when registering same id twice", () => {
    registry.register("noop", () => {});
    const scheduler = new Scheduler({ db, registry });

    scheduler.register({ id: "dup", kind: "manual", schedule_expr: "", handler_id: "noop" });

    expect(() =>
      scheduler.register({ id: "dup", kind: "manual", schedule_expr: "", handler_id: "noop" }),
    ).toThrow(SchedulerError);

    try {
      scheduler.register({ id: "dup", kind: "manual", schedule_expr: "", handler_id: "noop" });
    } catch (e: unknown) {
      expect(e).toBeInstanceOf(SchedulerError);
      expect((e as SchedulerError).reason).toBe("duplicate_task");
    }
  });

  test("unknown_handler error when handler_id is not in registry", () => {
    const scheduler = new Scheduler({ db, registry });

    expect(() =>
      scheduler.register({
        id: "task1",
        kind: "manual",
        schedule_expr: "",
        handler_id: "ghost",
      }),
    ).toThrow(SchedulerError);

    try {
      scheduler.register({
        id: "task1",
        kind: "manual",
        schedule_expr: "",
        handler_id: "ghost",
      });
    } catch (e: unknown) {
      expect(e).toBeInstanceOf(SchedulerError);
      expect((e as SchedulerError).reason).toBe("unknown_handler");
    }
  });

  test("invalid_cron error when cron expression is malformed", () => {
    registry.register("noop", () => {});
    const scheduler = new Scheduler({ db, registry });

    expect(() =>
      scheduler.register({
        id: "bad-cron",
        kind: "cron",
        schedule_expr: "not a cron",
        handler_id: "noop",
      }),
    ).toThrow(SchedulerError);

    try {
      scheduler.register({
        id: "bad-cron",
        kind: "cron",
        schedule_expr: "not a cron",
        handler_id: "noop",
      });
    } catch (e: unknown) {
      expect(e).toBeInstanceOf(SchedulerError);
      expect((e as SchedulerError).reason).toBe("invalid_cron");
    }
  });

  test("unknown_task run throws with correct reason", async () => {
    const scheduler = new Scheduler({ db, registry });

    try {
      await scheduler.run("nonexistent");
    } catch (e: unknown) {
      expect(e).toBeInstanceOf(SchedulerError);
      expect((e as SchedulerError).reason).toBe("unknown_task");
    }
  });

  test("SchedulerError has code 'scheduler'", () => {
    const err = new SchedulerError("duplicate_task", "test msg");
    expect(err.code).toBe("scheduler");
    expect(err.reason).toBe("duplicate_task");
    expect(err.message).toBe("test msg");
    expect(err.name).toBe("SchedulerError");
    expect(err).toBeInstanceOf(Error);
  });
});

// ---------------------------------------------------------------------------
// TaskPersistence — setEnabled
// ---------------------------------------------------------------------------

describe("TaskPersistence — setEnabled", () => {
  test("setEnabled can disable and re-enable a task", () => {
    const db = makeDb();
    const registry = new HandlerRegistry();
    registry.register("noop", () => {});

    const scheduler = new Scheduler({ db, registry });
    scheduler.register({
      id: "toggle-task",
      kind: "manual",
      schedule_expr: "",
      handler_id: "noop",
    });

    const persistence = new TaskPersistence(db);

    persistence.setEnabled("toggle-task", false);
    const disabled = persistence.get("toggle-task");
    expect(disabled?.enabled).toBe(false);

    persistence.setEnabled("toggle-task", true);
    const enabled = persistence.get("toggle-task");
    expect(enabled?.enabled).toBe(true);

    db.close();
  });
});

// ---------------------------------------------------------------------------
// HandlerRegistry
// ---------------------------------------------------------------------------

describe("HandlerRegistry", () => {
  test("register and get a handler", () => {
    const reg = new HandlerRegistry();
    const handler = () => {};
    reg.register("h1", handler);
    expect(reg.get("h1")).toBe(handler);
  });

  test("get unknown handler throws SchedulerError(unknown_handler)", () => {
    const reg = new HandlerRegistry();
    expect(() => reg.get("missing")).toThrow(SchedulerError);
    try {
      reg.get("missing");
    } catch (e: unknown) {
      expect(e).toBeInstanceOf(SchedulerError);
      expect((e as SchedulerError).reason).toBe("unknown_handler");
    }
  });

  test("has returns false before register and true after", () => {
    const reg = new HandlerRegistry();
    expect(reg.has("h")).toBe(false);
    reg.register("h", () => {});
    expect(reg.has("h")).toBe(true);
  });

  test("register overwrites an existing handler", () => {
    const reg = new HandlerRegistry();
    const h1 = () => {};
    const h2 = () => {};
    reg.register("h", h1);
    reg.register("h", h2);
    expect(reg.get("h")).toBe(h2);
  });
});

// ---------------------------------------------------------------------------
// Scheduler — eventBus getter and edge cases
// ---------------------------------------------------------------------------

describe("Scheduler — eventBus getter", () => {
  test("eventBus getter returns the injected bus", () => {
    const db = makeDb();
    const registry = new HandlerRegistry();
    const bus = new EventBus();
    const scheduler = new Scheduler({ db, registry, events: bus });

    expect(scheduler.eventBus).toBe(bus);
    db.close();
  });

  test("eventBus getter returns a bus when none is injected", () => {
    const db = makeDb();
    const registry = new HandlerRegistry();
    const scheduler = new Scheduler({ db, registry });

    expect(scheduler.eventBus).toBeInstanceOf(EventBus);
    db.close();
  });

  test("unregister of unknown id is a no-op and does not throw", () => {
    const db = makeDb();
    const registry = new HandlerRegistry();
    const scheduler = new Scheduler({ db, registry });

    expect(() => scheduler.unregister("nonexistent-id")).not.toThrow();
    db.close();
  });
});

// ---------------------------------------------------------------------------
// EventBus
// ---------------------------------------------------------------------------

describe("EventBus", () => {
  test("emit triggers listener", () => {
    const bus = new EventBus();
    let called = false;
    bus.on("topic", () => {
      called = true;
    });
    bus.emit("topic");
    expect(called).toBe(true);
  });

  test("off removes listener", () => {
    const bus = new EventBus();
    let callCount = 0;
    const listener = () => {
      callCount++;
    };
    bus.on("t", listener);
    bus.emit("t");
    bus.off("t", listener);
    bus.emit("t");
    expect(callCount).toBe(1);
  });

  test("payload is passed to listener", () => {
    const bus = new EventBus();
    let received: unknown;
    bus.on("t", (p) => {
      received = p;
    });
    bus.emit("t", { x: 42 });
    expect(received).toEqual({ x: 42 });
  });

  test("emit on unsubscribed topic is a no-op", () => {
    const bus = new EventBus();
    expect(() => bus.emit("no-listeners")).not.toThrow();
  });

  test("removeAllListeners for a specific topic", () => {
    const bus = new EventBus();
    let callCount = 0;
    bus.on("a", () => {
      callCount++;
    });
    bus.on("b", () => {
      callCount++;
    });
    bus.removeAllListeners("a");
    bus.emit("a");
    bus.emit("b");
    expect(callCount).toBe(1);
  });
});
