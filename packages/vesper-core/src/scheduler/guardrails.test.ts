/**
 * Tests for scheduler guardrails (DEV-108):
 * - max_runs_per_day
 * - max_concurrent
 * - max_duration_ms
 * - exponential backoff on failure
 * - dead-letter after MAX_ATTEMPTS
 * - no-cap tasks behave exactly as before
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { SqliteStore } from "../storage/store.ts";
import { SchedulerError } from "./errors.ts";
import { EventBus } from "./events.ts";
import { TaskPersistence } from "./persistence.ts";
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

// A date that matches "30 9 15 1 3" (Jan 15 2025 09:30 Wednesday)
const MATCH_DATE = new Date(2025, 0, 15, 9, 30, 0, 0);

// ---------------------------------------------------------------------------
// No-cap tasks behave as before
// ---------------------------------------------------------------------------

describe("Guardrails — no caps configured", () => {
  let db: Database;
  let registry: HandlerRegistry;

  beforeEach(() => {
    db = makeDb();
    registry = new HandlerRegistry();
  });

  afterEach(() => {
    db.close();
  });

  test("task with no caps runs normally on tick", async () => {
    let ran = false;
    registry.register("noop", () => {
      ran = true;
    });

    const scheduler = new Scheduler({ db, registry, clock: fakeClock(MATCH_DATE) });
    scheduler.register({
      id: "t1",
      kind: "cron",
      schedule_expr: "30 9 15 1 3",
      handler_id: "noop",
    });

    await scheduler.tick(MATCH_DATE);
    expect(ran).toBe(true);
  });

  test("task with no caps — handler error is recorded and tick does not throw", async () => {
    registry.register("failing", () => {
      throw new Error("boom");
    });

    const scheduler = new Scheduler({ db, registry, clock: fakeClock(MATCH_DATE) });
    scheduler.register({
      id: "f1",
      kind: "cron",
      schedule_expr: "30 9 15 1 3",
      handler_id: "failing",
    });

    await expect(scheduler.tick(MATCH_DATE)).resolves.toBeUndefined();

    const task = scheduler.list()[0];
    expect(task?.last_error).toBe("boom");
  });

  test("task with no caps — manual run propagates error", async () => {
    registry.register("failing", () => {
      throw new Error("kaboom");
    });

    const scheduler = new Scheduler({ db, registry });
    scheduler.register({ id: "m1", kind: "manual", schedule_expr: "", handler_id: "failing" });

    await expect(scheduler.run("m1")).rejects.toThrow("kaboom");
  });
});

// ---------------------------------------------------------------------------
// max_runs_per_day
// ---------------------------------------------------------------------------

describe("Guardrails — max_runs_per_day", () => {
  let db: Database;
  let registry: HandlerRegistry;

  beforeEach(() => {
    db = makeDb();
    registry = new HandlerRegistry();
  });

  afterEach(() => {
    db.close();
  });

  test("task is disabled and not run once daily cap is reached", async () => {
    let runCount = 0;
    registry.register("counter", () => {
      runCount++;
    });

    const scheduler = new Scheduler({ db, registry, clock: fakeClock(MATCH_DATE) });
    scheduler.register({
      id: "daily-cap",
      kind: "cron",
      schedule_expr: "30 9 15 1 3",
      handler_id: "counter",
      max_runs_per_day: 1,
    });

    // First tick: should run and count.
    await scheduler.tick(MATCH_DATE);
    expect(runCount).toBe(1);

    // Second tick same day: daily cap reached, task should be disabled and NOT run again.
    await scheduler.tick(MATCH_DATE);
    expect(runCount).toBe(1); // handler NOT called again

    const task = scheduler.list()[0];
    expect(task?.enabled).toBe(false);
    expect(task?.last_error).toContain("max_runs_per_day cap");
    expect(task?.last_error).toContain("1");
  });

  test("daily counter resets when the date rolls over", async () => {
    let runCount = 0;
    registry.register("counter", () => {
      runCount++;
    });

    const day1 = new Date(2025, 0, 15, 9, 30, 0, 0);
    const day2 = new Date(2025, 0, 16, 9, 30, 0, 0);

    let clockDate = day1;
    const scheduler = new Scheduler({ db, registry, clock: () => clockDate });
    scheduler.register({
      id: "daily-roll",
      kind: "cron",
      schedule_expr: "30 9 * * *",
      handler_id: "counter",
      max_runs_per_day: 1,
    });

    // Day 1: run once, cap reached, task disabled.
    await scheduler.tick(day1);
    expect(runCount).toBe(1);

    // Try again same day — disabled, no extra run.
    await scheduler.tick(day1);
    expect(runCount).toBe(1);

    // Re-enable the task to test day rollover.
    const persistence = new TaskPersistence(db);
    persistence.setEnabled("daily-roll", true);

    // Day 2: counter should reset. Advance clock.
    clockDate = day2;
    await scheduler.tick(day2);
    expect(runCount).toBe(2);
  });

  test("max_runs_per_day audited reason is set in last_error", async () => {
    registry.register("noop", () => {});

    const scheduler = new Scheduler({ db, registry, clock: fakeClock(MATCH_DATE) });
    scheduler.register({
      id: "audit-test",
      kind: "cron",
      schedule_expr: "30 9 15 1 3",
      handler_id: "noop",
      max_runs_per_day: 1,
    });

    // Run once to hit cap.
    await scheduler.tick(MATCH_DATE);
    // Trigger cap.
    await scheduler.tick(MATCH_DATE);

    const task = scheduler.list()[0];
    expect(task?.last_error).toMatch(/max_runs_per_day cap \(1\) reached for 2025-01-15/);
  });
});

// ---------------------------------------------------------------------------
// max_concurrent
// ---------------------------------------------------------------------------

describe("Guardrails — max_concurrent", () => {
  let db: Database;
  let registry: HandlerRegistry;

  beforeEach(() => {
    db = makeDb();
    registry = new HandlerRegistry();
  });

  afterEach(() => {
    db.close();
  });

  test("concurrent runs are limited: second tick while first still in-flight is skipped", async () => {
    let resolveFirst!: () => void;
    let startCount = 0;

    registry.register("slow", async () => {
      startCount++;
      await new Promise<void>((resolve) => {
        resolveFirst = resolve;
      });
    });

    const scheduler = new Scheduler({ db, registry, clock: fakeClock(MATCH_DATE) });
    scheduler.register({
      id: "conc-task",
      kind: "cron",
      schedule_expr: "30 9 15 1 3",
      handler_id: "slow",
      max_concurrent: 1,
    });

    // Start first tick but don't await it yet (it will hang waiting for resolveFirst).
    const firstTick = scheduler.tick(MATCH_DATE);

    // Give the first tick time to start executing the handler.
    await new Promise<void>((resolve) => setTimeout(resolve, 10));

    // Second tick while first is in-flight — should be skipped.
    await scheduler.tick(MATCH_DATE);

    // Only one handler started.
    expect(startCount).toBe(1);

    // Resolve the first.
    resolveFirst();
    await firstTick;
  });

  test("after first run completes, second run proceeds", async () => {
    let runCount = 0;
    registry.register("fast", () => {
      runCount++;
    });

    const scheduler = new Scheduler({ db, registry, clock: fakeClock(MATCH_DATE) });
    scheduler.register({
      id: "seq-task",
      kind: "cron",
      schedule_expr: "30 9 15 1 3",
      handler_id: "fast",
      max_concurrent: 1,
    });

    await scheduler.tick(MATCH_DATE);
    await scheduler.tick(MATCH_DATE);

    // Both ran since each completed before the next tick.
    expect(runCount).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// max_duration_ms
// ---------------------------------------------------------------------------

describe("Guardrails — max_duration_ms", () => {
  let db: Database;
  let registry: HandlerRegistry;

  beforeEach(() => {
    db = makeDb();
    registry = new HandlerRegistry();
  });

  afterEach(() => {
    db.close();
  });

  test("handler that exceeds duration is aborted and treated as failure", async () => {
    registry.register("slow", async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 200));
    });

    const scheduler = new Scheduler({ db, registry, clock: fakeClock(MATCH_DATE) });
    scheduler.register({
      id: "timeout-task",
      kind: "cron",
      schedule_expr: "30 9 15 1 3",
      handler_id: "slow",
      max_duration_ms: 50,
    });

    await scheduler.tick(MATCH_DATE);

    const task = scheduler.list()[0];
    expect(task?.last_error).toContain("max_duration_ms");
    expect(task?.last_error).toContain("50ms");
    // attempt_count incremented.
    expect(task?.attempt_count).toBe(1);
  }, 10000);

  test("handler that completes within duration is not aborted", async () => {
    let ran = false;
    registry.register("fast", async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
      ran = true;
    });

    const scheduler = new Scheduler({ db, registry, clock: fakeClock(MATCH_DATE) });
    scheduler.register({
      id: "ok-task",
      kind: "cron",
      schedule_expr: "30 9 15 1 3",
      handler_id: "fast",
      max_duration_ms: 500,
    });

    await scheduler.tick(MATCH_DATE);
    expect(ran).toBe(true);

    const task = scheduler.list()[0];
    expect(task?.last_error).toBeNull();
  }, 10000);
});

// ---------------------------------------------------------------------------
// Exponential backoff
// ---------------------------------------------------------------------------

describe("Guardrails — exponential backoff", () => {
  let db: Database;
  let registry: HandlerRegistry;

  beforeEach(() => {
    db = makeDb();
    registry = new HandlerRegistry();
  });

  afterEach(() => {
    db.close();
  });

  test("task is not retried before next_attempt_at", async () => {
    let runCount = 0;
    registry.register("failing", () => {
      runCount++;
      throw new Error("fail");
    });

    const t0 = new Date(2025, 0, 15, 9, 30, 0, 0);
    let clockDate = t0;
    const scheduler = new Scheduler({ db, registry, clock: () => clockDate });
    scheduler.register({
      id: "backoff-task",
      kind: "cron",
      schedule_expr: "30 9 15 1 3",
      handler_id: "failing",
    });

    // First tick: fails, attempt_count=1, next_attempt_at = t0 + 1000ms.
    await scheduler.tick(t0);
    expect(runCount).toBe(1);

    const afterFirst = scheduler.list()[0];
    expect(afterFirst?.attempt_count).toBe(1);
    expect(afterFirst?.next_attempt_at).not.toBeNull();
    const nextAttemptAt = afterFirst?.next_attempt_at ?? 0;

    // Tick at t0 + 500ms — still in backoff, should not run.
    clockDate = new Date(t0.getTime() + 500);
    await scheduler.tick(clockDate);
    expect(runCount).toBe(1); // no extra run

    // Tick at next_attempt_at + 1ms — backoff expired, should run.
    clockDate = new Date(nextAttemptAt + 1);
    await scheduler.tick(clockDate);
    expect(runCount).toBe(2);
  });

  test("attempt_count resets to 0 on success after failures", async () => {
    let shouldFail = true;
    registry.register("conditional", () => {
      if (shouldFail) throw new Error("fail");
    });

    const t0 = new Date(2025, 0, 15, 9, 30, 0, 0);
    let clockDate = t0;
    const scheduler = new Scheduler({ db, registry, clock: () => clockDate });
    scheduler.register({
      id: "reset-task",
      kind: "cron",
      schedule_expr: "30 9 15 1 3",
      handler_id: "conditional",
    });

    // First tick: fails, attempt_count=1.
    await scheduler.tick(t0);
    expect(scheduler.list()[0]?.attempt_count).toBe(1);

    // Move past backoff.
    const afterFirst = scheduler.list()[0];
    const nextAttempt = afterFirst?.next_attempt_at ?? 0;
    clockDate = new Date(nextAttempt + 1);

    // Now succeed.
    shouldFail = false;
    await scheduler.tick(clockDate);

    const task = scheduler.list()[0];
    expect(task?.attempt_count).toBe(0);
    expect(task?.next_attempt_at).toBeNull();
    expect(task?.last_error).toBeNull();
  });

  test("backoff delay doubles with each failure (base 1000ms)", async () => {
    registry.register("always-fail", () => {
      throw new Error("fail");
    });

    const t0 = new Date(2025, 0, 15, 9, 30, 0, 0);
    let clockDate = t0;
    const scheduler = new Scheduler({ db, registry, clock: () => clockDate });
    scheduler.register({
      id: "double-task",
      kind: "cron",
      schedule_expr: "30 9 15 1 3",
      handler_id: "always-fail",
    });

    // Attempt 1: backoff = 1000ms.
    await scheduler.tick(t0);
    const after1 = scheduler.list()[0];
    expect(after1?.attempt_count).toBe(1);
    const next1 = after1?.next_attempt_at ?? 0;
    expect(next1 - t0.getTime()).toBe(1000);

    // Attempt 2: move past backoff, backoff = 2000ms.
    clockDate = new Date(next1 + 1);
    const t1 = clockDate;
    await scheduler.tick(clockDate);
    const after2 = scheduler.list()[0];
    expect(after2?.attempt_count).toBe(2);
    const next2 = after2?.next_attempt_at ?? 0;
    expect(next2 - t1.getTime()).toBe(2000);

    // Attempt 3: backoff = 4000ms.
    clockDate = new Date(next2 + 1);
    const t2 = clockDate;
    await scheduler.tick(clockDate);
    const after3 = scheduler.list()[0];
    expect(after3?.attempt_count).toBe(3);
    const next3 = after3?.next_attempt_at ?? 0;
    expect(next3 - t2.getTime()).toBe(4000);
  });
});

// ---------------------------------------------------------------------------
// Dead-letter (failed_tasks)
// ---------------------------------------------------------------------------

describe("Guardrails — dead-letter after max attempts", () => {
  let db: Database;
  let registry: HandlerRegistry;

  beforeEach(() => {
    db = makeDb();
    registry = new HandlerRegistry();
  });

  afterEach(() => {
    db.close();
  });

  test("task is disabled and dead-lettered after 5 consecutive failures", async () => {
    registry.register("always-fail", () => {
      throw new Error("persistent failure");
    });

    const baseTime = new Date(2025, 0, 15, 9, 30, 0, 0);
    let clockDate = baseTime;
    const scheduler = new Scheduler({ db, registry, clock: () => clockDate });
    scheduler.register({
      id: "dl-task",
      kind: "cron",
      schedule_expr: "30 9 15 1 3",
      handler_id: "always-fail",
    });

    // Run 5 times — each time move past backoff.
    for (let i = 0; i < 5; i++) {
      const taskBefore = scheduler.list()[0];
      // On first iteration, next_attempt_at is null so no need to advance.
      if (
        i > 0 &&
        taskBefore?.next_attempt_at !== null &&
        taskBefore?.next_attempt_at !== undefined
      ) {
        clockDate = new Date(taskBefore.next_attempt_at + 1);
      }
      await scheduler.tick(clockDate);
    }

    const task = scheduler.list()[0];
    expect(task?.enabled).toBe(false);
    expect(task?.attempt_count).toBe(5);

    // Check failed_tasks table.
    const persistence = new TaskPersistence(db);
    const failedTasks = persistence.listFailedTasks();
    expect(failedTasks).toHaveLength(1);
    expect(failedTasks[0]?.task_id).toBe("dl-task");
    expect(failedTasks[0]?.error).toBe("persistent failure");
    expect(failedTasks[0]?.attempt_count).toBe(5);
  });

  test("task does NOT run after being dead-lettered (disabled)", async () => {
    let runCount = 0;
    registry.register("always-fail", () => {
      runCount++;
      throw new Error("fail");
    });

    const baseTime = new Date(2025, 0, 15, 9, 30, 0, 0);
    let clockDate = baseTime;
    const scheduler = new Scheduler({ db, registry, clock: () => clockDate });
    scheduler.register({
      id: "no-more-runs",
      kind: "cron",
      schedule_expr: "30 9 15 1 3",
      handler_id: "always-fail",
    });

    // Exhaust attempts.
    for (let i = 0; i < 5; i++) {
      const taskBefore = scheduler.list()[0];
      if (
        i > 0 &&
        taskBefore?.next_attempt_at !== null &&
        taskBefore?.next_attempt_at !== undefined
      ) {
        clockDate = new Date(taskBefore.next_attempt_at + 1);
      }
      await scheduler.tick(clockDate);
    }

    const countAfter5 = runCount;
    // One more tick — task should be disabled, handler not called.
    clockDate = new Date(clockDate.getTime() + 100_000);
    await scheduler.tick(clockDate);
    expect(runCount).toBe(countAfter5);
  });

  test("failed_tasks has unique id per dead-letter entry", async () => {
    registry.register("fail1", () => {
      throw new Error("e1");
    });
    registry.register("fail2", () => {
      throw new Error("e2");
    });

    const EXPR = "30 9 15 1 3";
    const baseTime = new Date(2025, 0, 15, 9, 30, 0, 0);
    let clock1 = baseTime;
    let clock2 = baseTime;

    const db2 = makeDb();
    try {
      const s1 = new Scheduler({ db, registry, clock: () => clock1 });
      const s2 = new Scheduler({ db: db2, registry, clock: () => clock2 });

      s1.register({ id: "t1", kind: "cron", schedule_expr: EXPR, handler_id: "fail1" });
      s2.register({ id: "t2", kind: "cron", schedule_expr: EXPR, handler_id: "fail2" });

      for (let i = 0; i < 5; i++) {
        const t1Before = s1.list()[0];
        if (
          i > 0 &&
          t1Before?.next_attempt_at !== null &&
          t1Before?.next_attempt_at !== undefined
        ) {
          clock1 = new Date(t1Before.next_attempt_at + 1);
        }
        await s1.tick(clock1);

        const t2Before = s2.list()[0];
        if (
          i > 0 &&
          t2Before?.next_attempt_at !== null &&
          t2Before?.next_attempt_at !== undefined
        ) {
          clock2 = new Date(t2Before.next_attempt_at + 1);
        }
        await s2.tick(clock2);
      }

      const p1 = new TaskPersistence(db);
      const p2 = new TaskPersistence(db2);
      const f1 = p1.listFailedTasks();
      const f2 = p2.listFailedTasks();

      expect(f1).toHaveLength(1);
      expect(f2).toHaveLength(1);
      // Different entries have different ids.
      expect(f1[0]?.id).not.toBe(f2[0]?.id);
    } finally {
      db2.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Event tasks with guardrails
// ---------------------------------------------------------------------------

describe("Guardrails — event tasks", () => {
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

  test("max_runs_per_day applies to event-triggered runs", async () => {
    let runCount = 0;
    registry.register("counter", () => {
      runCount++;
    });

    const day = new Date(2025, 0, 15, 9, 30, 0, 0);
    const scheduler = new Scheduler({ db, registry, events: bus, clock: fakeClock(day) });
    scheduler.register({
      id: "evt-cap",
      kind: "event",
      schedule_expr: "user.signup",
      handler_id: "counter",
      max_runs_per_day: 1,
    });

    bus.emit("user.signup");
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    expect(runCount).toBe(1);

    // Second emit same day: cap should fire and disable task.
    bus.emit("user.signup");
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    // Handler was NOT called a second time.
    expect(runCount).toBe(1);

    const task = scheduler.list()[0];
    expect(task?.enabled).toBe(false);
  });

  test("max_concurrent applies to event-triggered runs", async () => {
    let inFlightCount = 0;
    let maxObserved = 0;

    registry.register("slow", async () => {
      inFlightCount++;
      maxObserved = Math.max(maxObserved, inFlightCount);
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
      inFlightCount--;
    });

    const scheduler = new Scheduler({ db, registry, events: bus, clock: fakeClock(MATCH_DATE) });
    scheduler.register({
      id: "conc-evt",
      kind: "event",
      schedule_expr: "data.ready",
      handler_id: "slow",
      max_concurrent: 1,
    });

    // Emit twice rapidly — the second should be skipped due to max_concurrent=1.
    bus.emit("data.ready");
    bus.emit("data.ready");

    await new Promise<void>((resolve) => setTimeout(resolve, 100));

    // Max concurrent observed should be 1 (second was skipped).
    expect(maxObserved).toBe(1);
  }, 10000);
});

// ---------------------------------------------------------------------------
// Persistence — new fields round-trip
// ---------------------------------------------------------------------------

describe("Persistence — guardrail fields round-trip", () => {
  test("caps and bookkeeping fields are persisted and read back", () => {
    const db = makeDb();
    const registry = new HandlerRegistry();
    registry.register("noop", () => {});

    const scheduler = new Scheduler({ db, registry });
    scheduler.register({
      id: "full-caps",
      kind: "manual",
      schedule_expr: "",
      handler_id: "noop",
      max_runs_per_day: 5,
      max_concurrent: 2,
      max_duration_ms: 1000,
    });

    // Reload from same db.
    const s2 = new Scheduler({ db, registry });
    const task = s2.list()[0];

    expect(task?.max_runs_per_day).toBe(5);
    expect(task?.max_concurrent).toBe(2);
    expect(task?.max_duration_ms).toBe(1000);
    expect(task?.runs_today).toBe(0);
    expect(task?.runs_today_date).toBeNull();
    expect(task?.attempt_count).toBe(0);
    expect(task?.next_attempt_at).toBeNull();

    db.close();
  });

  test("task with no caps has null guardrail fields", () => {
    const db = makeDb();
    const registry = new HandlerRegistry();
    registry.register("noop", () => {});

    const scheduler = new Scheduler({ db, registry });
    scheduler.register({ id: "bare", kind: "manual", schedule_expr: "", handler_id: "noop" });

    const task = scheduler.list()[0];
    expect(task?.max_runs_per_day).toBeNull();
    expect(task?.max_concurrent).toBeNull();
    expect(task?.max_duration_ms).toBeNull();

    db.close();
  });
});

// ---------------------------------------------------------------------------
// Manual run cap-violation reason
// ---------------------------------------------------------------------------

describe("Scheduler — manual run blocked by a cap", () => {
  test("throws SchedulerError(cap_exceeded), not unknown_task, and does not run the handler", async () => {
    const db = makeDb();
    const registry = new HandlerRegistry();
    let ran = false;
    registry.register("noop", () => {
      ran = true;
    });

    const scheduler = new Scheduler({ db, registry, clock: fakeClock(MATCH_DATE) });
    // max_runs_per_day: 0 blocks every run, exercising the manual cap-violation path.
    scheduler.register({
      id: "capped",
      kind: "manual",
      schedule_expr: "",
      handler_id: "noop",
      max_runs_per_day: 0,
    });

    const error = await scheduler.run("capped").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SchedulerError);
    expect((error as SchedulerError).reason).toBe("cap_exceeded");
    expect(ran).toBe(false);

    db.close();
  });
});
