import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { CAPABILITIES } from "../capabilities/capability.ts";
import { CapabilityError } from "../capabilities/errors.ts";
import { SqliteStore } from "../storage/store.ts";
import { TaskPersistence } from "./persistence.ts";
import { HandlerRegistry } from "./registry.ts";
import { Scheduler } from "./scheduler.ts";
import type { CompleteFn } from "./types.ts";

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
