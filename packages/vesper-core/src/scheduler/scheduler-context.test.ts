import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { CAPABILITIES } from "../capabilities/capability.ts";
import { CapabilityError } from "../capabilities/errors.ts";
import { SqliteStore } from "../storage/store.ts";
import { RUN_COMPLETED } from "./events.ts";
import { TaskPersistence } from "./persistence.ts";
import { HandlerRegistry } from "./registry.ts";
import { Scheduler } from "./scheduler.ts";
import type { CompleteFn, RunOutcome } from "./types.ts";

// ---------------------------------------------------------------------------
// Helpers — an in-memory DB with migrations applied, plus a recording resolver.
// ---------------------------------------------------------------------------

function makeDb(): Database {
  const db = new Database(":memory:");
  new SqliteStore(db).migrate();
  return db;
}

interface CompleteCall {
  readonly prompt: string;
  readonly cli: string | undefined;
}

/** A fake CompleteFn that records calls and returns a canned completion. */
function recordingComplete(text = "pong"): { fn: CompleteFn; calls: CompleteCall[] } {
  const calls: CompleteCall[] = [];
  const fn: CompleteFn = async (prompt, opts) => {
    calls.push({ prompt, cli: opts?.cli });
    return { text, exit_code: 0, raw_stdout: text, raw_stderr: "", duration_ms: 1 };
  };
  return { fn, calls };
}

// ---------------------------------------------------------------------------
// Integrated runtime-context path: scheduler.run(id, options) end to end.
// ---------------------------------------------------------------------------

describe("Scheduler — pipeline runtime context", () => {
  let db: Database;
  let registry: HandlerRegistry;

  beforeEach(() => {
    db = makeDb();
    registry = new HandlerRegistry();
  });

  afterEach(() => {
    db.close();
  });

  test("manual run resolves the per-run CLI, completes, and records a runs row", async () => {
    const { fn, calls } = recordingComplete("hello back");
    registry.register("echo", async (ctx) => {
      const prompt = typeof ctx.params.prompt === "string" ? ctx.params.prompt : "default";
      const result = await ctx.complete(prompt);
      ctx.recordRun({ status: "ok", summary: result.text });
    });

    const scheduler = new Scheduler({ db, registry, grants: CAPABILITIES, complete: fn });
    scheduler.register({
      id: "echo",
      kind: "manual",
      schedule_expr: "",
      handler_id: "echo",
      required_capabilities: ["CLI_INVOKE", "WRITE_STORAGE"],
    });

    const outcome = await scheduler.run("echo", { cli: "codex", params: { prompt: "ping" } });

    // The returned RunOutcome reflects what the handler recorded + the per-run CLI.
    expect(outcome.taskId).toBe("echo");
    expect(outcome.status).toBe("ok");
    expect(outcome.summary).toBe("hello back");
    expect(outcome.cli).toBe("codex");
    expect(outcome.runId).not.toBeNull();
    expect(typeof outcome.durationMs).toBe("number");
    expect(outcome.durationMs).toBeGreaterThanOrEqual(0);

    // The injected resolver saw the per-run override and the prompt.
    expect(calls).toEqual([{ prompt: "ping", cli: "codex" }]);

    // A real runs row was written, keyed by the handler id.
    const runs = new SqliteStore(db).listRuns({ pipeline: "echo" });
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe("ok");
    expect(runs[0]?.summary).toBe("hello back");

    // last_run_at is set and there is no error.
    const task = new TaskPersistence(db).get("echo");
    expect(task?.last_run_at).not.toBeNull();
    expect(task?.last_error).toBeNull();
  });

  test("a handler that records a run then throws keeps the recorded status (no error clobber)", async () => {
    registry.register("recorder", async (ctx) => {
      ctx.recordRun({ status: "partial", summary: "committed before failure" });
      throw new Error("boom after record");
    });

    const scheduler = new Scheduler({ db, registry, grants: CAPABILITIES });
    scheduler.register({
      id: "recorder",
      kind: "manual",
      schedule_expr: "",
      handler_id: "recorder",
      required_capabilities: ["WRITE_STORAGE"],
    });

    // The manual run propagates the handler error.
    await expect(scheduler.run("recorder")).rejects.toThrow("boom after record");

    // The run row keeps the handler-committed status: the catch path must NOT
    // overwrite an already-finalized row with status 'error'.
    const runs = new SqliteStore(db).listRuns({ pipeline: "recorder" });
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe("partial");
    expect(runs[0]?.summary).toBe("committed before failure");
  });

  test("emits a run:completed event carrying the RunOutcome", async () => {
    const { fn } = recordingComplete("pong");
    registry.register("echo", async (ctx) => {
      await ctx.complete("p");
      ctx.recordRun({ status: "ok", summary: "done" });
    });
    const scheduler = new Scheduler({ db, registry, grants: CAPABILITIES, complete: fn });
    scheduler.register({
      id: "echo",
      kind: "manual",
      schedule_expr: "",
      handler_id: "echo",
      required_capabilities: ["CLI_INVOKE", "WRITE_STORAGE"],
    });

    const events: RunOutcome[] = [];
    scheduler.eventBus.on(RUN_COMPLETED, (p) => events.push(p as RunOutcome));

    await scheduler.run("echo");

    expect(events).toHaveLength(1);
    expect(events[0]?.taskId).toBe("echo");
    expect(events[0]?.status).toBe("ok");
    expect(events[0]?.summary).toBe("done");
  });

  test("with no --cli override the resolver receives no cli (picks its default)", async () => {
    const { fn, calls } = recordingComplete();
    registry.register("echo", async (ctx) => {
      await ctx.complete("p");
      ctx.recordRun({ status: "ok", summary: "done" });
    });

    const scheduler = new Scheduler({ db, registry, grants: CAPABILITIES, complete: fn });
    scheduler.register({
      id: "echo",
      kind: "manual",
      schedule_expr: "",
      handler_id: "echo",
      required_capabilities: ["CLI_INVOKE", "WRITE_STORAGE"],
    });

    await scheduler.run("echo");

    expect(calls[0]?.cli).toBeUndefined();
  });

  test("a handler that omits CLI_INVOKE is refused before any CLI is invoked", async () => {
    const { fn, calls } = recordingComplete();
    registry.register("nocap", async (ctx) => {
      await ctx.complete("p");
    });

    const scheduler = new Scheduler({ db, registry, grants: CAPABILITIES, complete: fn });
    scheduler.register({
      id: "nocap",
      kind: "manual",
      schedule_expr: "",
      handler_id: "nocap",
      // Declares WRITE_STORAGE only — CLI_INVOKE is omitted on purpose.
      required_capabilities: ["WRITE_STORAGE"],
    });

    await expect(scheduler.run("nocap")).rejects.toBeInstanceOf(CapabilityError);
    expect(calls).toHaveLength(0);
  });

  test("readSignals returns real run rows from the live store + task persistence", async () => {
    // Seed an error run row so the gather window has something to roll up.
    const store = new SqliteStore(db);
    store.recordRun({ pipeline: "broken", status: "error", summary: "kaboom" });

    let rollupErrors: number | undefined;
    let taskErrorCount: number | undefined;
    registry.register("evolve", (ctx) => {
      const signals = ctx.readSignals();
      rollupErrors = signals.rollups.find((r) => r.pipeline === "broken")?.errors;
      taskErrorCount = signals.taskErrors.length;
      ctx.recordRun({ status: "ok", summary: signals.digest.slice(0, 50) });
    });

    const scheduler = new Scheduler({ db, registry, grants: CAPABILITIES });
    scheduler.register({
      id: "evolve",
      kind: "manual",
      schedule_expr: "",
      handler_id: "evolve",
      required_capabilities: ["READ_STORAGE", "WRITE_STORAGE"],
    });

    await scheduler.run("evolve");

    // The gather seam saw the seeded error run via the live store.
    expect(rollupErrors).toBe(1);
    // No task carries a last_error yet, so taskErrors is empty (persistence wired, just empty).
    expect(taskErrorCount).toBe(0);
  });

  test("readSignals is refused when READ_STORAGE is not declared", async () => {
    registry.register("noread", (ctx) => {
      ctx.readSignals();
    });
    const scheduler = new Scheduler({ db, registry, grants: CAPABILITIES });
    scheduler.register({
      id: "noread",
      kind: "manual",
      schedule_expr: "",
      handler_id: "noread",
      required_capabilities: ["WRITE_STORAGE"],
    });

    await expect(scheduler.run("noread")).rejects.toBeInstanceOf(CapabilityError);
  });

  test("scheduled runs get empty params and no cli override", async () => {
    const { fn, calls } = recordingComplete();
    let seenParams: Readonly<Record<string, unknown>> | undefined;
    registry.register("echo", async (ctx) => {
      seenParams = ctx.params;
      await ctx.complete("p");
      ctx.recordRun({ status: "ok", summary: "x" });
    });

    const scheduler = new Scheduler({ db, registry, grants: CAPABILITIES, complete: fn });
    scheduler.register({
      id: "echo",
      kind: "manual",
      schedule_expr: "",
      handler_id: "echo",
      required_capabilities: ["CLI_INVOKE", "WRITE_STORAGE"],
    });

    // run() with no options is the scheduled-equivalent path (params default to {}).
    await scheduler.run("echo");

    expect(seenParams).toEqual({});
    expect(calls[0]?.cli).toBeUndefined();
  });
});
