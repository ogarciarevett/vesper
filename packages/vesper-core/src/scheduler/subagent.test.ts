import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { CAPABILITIES } from "../capabilities/capability.ts";
import { CapabilityError } from "../capabilities/errors.ts";
import { SqliteStore } from "../storage/store.ts";
import type { Store } from "../storage/types.ts";
import { SchedulerError } from "./errors.ts";
import { EventBus } from "./events.ts";
import { HandlerRegistry } from "./registry.ts";
import { Scheduler } from "./scheduler.ts";
import { runSubAgent } from "./subagent.ts";
import type { CompleteFn, PipelineContext, SubAgentHandle } from "./types.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDb(): Database {
  const db = new Database(":memory:");
  new SqliteStore(db).migrate();
  return db;
}

/** A registered child handler that just records a run. */
function recordingChild() {
  return async (ctx: PipelineContext): Promise<void> => {
    ctx.recordRun({ status: "ok", summary: "child done" });
  };
}

// ---------------------------------------------------------------------------
// Acceptance — spawning sub-agents
// ---------------------------------------------------------------------------

describe("ctx.spawn — sub-agent orchestration", () => {
  let db: Database;
  let store: Store;
  let registry: HandlerRegistry;

  beforeEach(() => {
    db = makeDb();
    store = new SqliteStore(db);
    registry = new HandlerRegistry();
  });

  afterEach(() => {
    db.close();
  });

  test("3 spawns produce 3 finished child rows parented to the run", async () => {
    registry.register("child", recordingChild());
    registry.register("parent", async (ctx) => {
      const handles: SubAgentHandle[] = [];
      for (let i = 0; i < 3; i++) {
        handles.push(
          ctx.spawn({ handlerId: "child", label: `child ${i}`, capabilities: ["WRITE_STORAGE"] }),
        );
      }
      await Promise.all(handles.map((h) => h.done));
      ctx.recordRun({ status: "ok", summary: "parent done" });
    });

    const scheduler = new Scheduler({ db, registry, grants: CAPABILITIES });
    scheduler.register({
      id: "parent",
      kind: "manual",
      schedule_expr: "",
      handler_id: "parent",
      required_capabilities: ["SPAWN_SUBAGENT", "WRITE_STORAGE"],
    });

    const outcome = await scheduler.run("parent");
    expect(outcome.runId).not.toBeNull();

    const children = store.listRuns({ parentRunId: outcome.runId });
    expect(children).toHaveLength(3);
    for (const child of children) {
      expect(child.parentRunId).toBe(outcome.runId as string);
      // Child rows are finished, not left 'running'.
      expect(child.status).not.toBe("running");
      expect(child.status).toBe("ok");
    }

    // The run tree reflects the hierarchy.
    const tree = store.runTree(outcome.runId as string);
    expect(tree?.children).toHaveLength(3);
  });

  test("descriptor cap outside the parent grant is refused (subset-of-parent gate)", async () => {
    registry.register("child", recordingChild());
    let thrown: unknown;
    registry.register("parent", async (ctx) => {
      try {
        ctx.spawn({ handlerId: "child", label: "rogue", capabilities: ["NETWORK_FETCH"] });
      } catch (err) {
        thrown = err;
      }
      ctx.recordRun({ status: "partial", summary: "refused" });
    });

    // Parent grant is exactly [SPAWN_SUBAGENT, WRITE_STORAGE]; host ceiling allows
    // everything, so the refusal is the subset-of-PARENT gate.
    const scheduler = new Scheduler({ db, registry, grants: CAPABILITIES });
    scheduler.register({
      id: "parent",
      kind: "manual",
      schedule_expr: "",
      handler_id: "parent",
      required_capabilities: ["SPAWN_SUBAGENT", "WRITE_STORAGE"],
    });

    const outcome = await scheduler.run("parent");
    expect(thrown).toBeInstanceOf(CapabilityError);
    // No dangling child row.
    expect(store.listRuns({ parentRunId: outcome.runId })).toHaveLength(0);
  });

  test("descriptor cap inside parent grant but outside host ceiling is refused (host-ceiling gate)", async () => {
    // The register ceiling forbids a task whose required_capabilities exceed the
    // host grant, so the host-ceiling side of the two-sided gate is exercised at
    // the runSubAgent layer: the parent grant (parentTaskCapabilities) INCLUDES
    // FS_READ, but the host ceiling (grants) EXCLUDES it -> refusal.
    registry.register("child", recordingChild());
    const events = new EventBus();
    // Build a minimal parent context standing in for an already-running parent.
    const parentRunId = store.startRun({ pipeline: "parent" });
    const parent: PipelineContext = {
      task: {
        id: "parent",
        kind: "manual",
        schedule_expr: "",
        handler_id: "parent",
        enabled: true,
        last_run_at: null,
        last_error: null,
        max_runs_per_day: null,
        max_concurrent: null,
        max_duration_ms: null,
        runs_today: 0,
        runs_today_date: null,
        attempt_count: 0,
        next_attempt_at: null,
        required_capabilities: ["SPAWN_SUBAGENT", "WRITE_STORAGE", "FS_READ"],
      },
      now: new Date(),
      params: {},
      runId: parentRunId,
      parentRunId: null,
      complete: async () => {
        throw new Error("unused");
      },
      recordRun: () => parentRunId,
      emitProgress: () => {},
      spawn: () => {
        throw new Error("unused");
      },
    };

    expect(() =>
      runSubAgent({
        descriptor: { handlerId: "child", label: "rogue", capabilities: ["FS_READ"] },
        parent,
        store,
        events,
        registry,
        // Host ceiling lacks FS_READ -> host-ceiling refusal even though the
        // parent grant includes it.
        grants: ["SPAWN_SUBAGENT", "WRITE_STORAGE"],
        parentTaskCapabilities: ["SPAWN_SUBAGENT", "WRITE_STORAGE", "FS_READ"],
        redactSummaries: false,
        parentRemainingMs: null,
        depth: 0,
        maxFanout: 8,
        childCount: () => 0,
      }),
    ).toThrow(CapabilityError);

    // No child row allocated for the refused spawn.
    expect(store.listRuns({ parentRunId })).toHaveLength(0);
  });

  test("a child that spawns is refused with subagent_depth (allSettled -> partial)", async () => {
    registry.register("grandchild", recordingChild());
    registry.register("child", async (ctx) => {
      // Depth-1 child cannot spawn.
      ctx.spawn({ handlerId: "grandchild", label: "gc", capabilities: [] });
    });
    let childError: unknown;
    registry.register("parent", async (ctx) => {
      const handle = ctx.spawn({
        handlerId: "child",
        label: "c",
        capabilities: ["SPAWN_SUBAGENT"],
      });
      const results = await Promise.allSettled([handle.done]);
      if (results[0]?.status === "rejected") childError = results[0].reason;
      ctx.recordRun({ status: "partial", summary: "child failed but we survived" });
    });

    const scheduler = new Scheduler({ db, registry, grants: CAPABILITIES });
    scheduler.register({
      id: "parent",
      kind: "manual",
      schedule_expr: "",
      handler_id: "parent",
      required_capabilities: ["SPAWN_SUBAGENT", "WRITE_STORAGE"],
    });

    const outcome = await scheduler.run("parent");
    expect(childError).toBeInstanceOf(SchedulerError);
    expect((childError as SchedulerError).reason).toBe("subagent_depth");
    // Exactly one child row (the depth-1 child); NO grandchild.
    const children = store.listRuns({ parentRunId: outcome.runId });
    expect(children).toHaveLength(1);
    expect(children[0]?.pipeline).toBe("child");
    expect(store.listRuns({ pipeline: "grandchild" })).toHaveLength(0);
    // The child row was finalized 'error'.
    expect(children[0]?.status).toBe("error");
  });

  test("maxFanout caps the number of children (3rd spawn throws fanout_exceeded)", async () => {
    registry.register("child", recordingChild());
    let fanoutError: unknown;
    registry.register("parent", async (ctx) => {
      const handles: SubAgentHandle[] = [];
      handles.push(ctx.spawn({ handlerId: "child", label: "c0", capabilities: ["WRITE_STORAGE"] }));
      handles.push(ctx.spawn({ handlerId: "child", label: "c1", capabilities: ["WRITE_STORAGE"] }));
      try {
        ctx.spawn({ handlerId: "child", label: "c2", capabilities: ["WRITE_STORAGE"] });
      } catch (err) {
        fanoutError = err;
      }
      await Promise.all(handles.map((h) => h.done));
      ctx.recordRun({ status: "ok", summary: "two children" });
    });

    const scheduler = new Scheduler({ db, registry, grants: CAPABILITIES, maxFanout: 2 });
    scheduler.register({
      id: "parent",
      kind: "manual",
      schedule_expr: "",
      handler_id: "parent",
      required_capabilities: ["SPAWN_SUBAGENT", "WRITE_STORAGE"],
    });

    const outcome = await scheduler.run("parent");
    expect(fanoutError).toBeInstanceOf(SchedulerError);
    expect((fanoutError as SchedulerError).reason).toBe("fanout_exceeded");
    // Only the first 2 children ran.
    expect(store.listRuns({ parentRunId: outcome.runId })).toHaveLength(2);
  });

  test("a child can emit progress, persisted under the child run id", async () => {
    registry.register("child", async (ctx) => {
      ctx.emitProgress({ kind: "step", message: "child step", data: { pct: 50 } });
      ctx.recordRun({ status: "ok", summary: "ok" });
    });
    registry.register("parent", async (ctx) => {
      const handle = ctx.spawn({
        handlerId: "child",
        label: "c",
        capabilities: ["WRITE_STORAGE"],
      });
      await handle.done;
      ctx.recordRun({ status: "ok", summary: "parent" });
    });

    const scheduler = new Scheduler({ db, registry, grants: CAPABILITIES });
    scheduler.register({
      id: "parent",
      kind: "manual",
      schedule_expr: "",
      handler_id: "parent",
      required_capabilities: ["SPAWN_SUBAGENT", "WRITE_STORAGE"],
    });

    const outcome = await scheduler.run("parent");
    const children = store.listRuns({ parentRunId: outcome.runId });
    expect(children).toHaveLength(1);
    const childRunId = children[0]?.id as string;

    const childEvents = store.listRunEvents({ runId: childRunId });
    const stepEvents = childEvents.filter((e) => e.kind === "step");
    expect(stepEvents).toHaveLength(1);
    expect(stepEvents[0]?.payload).toEqual({ message: "child step", data: { pct: 50 } });

    // The parent run records a 'spawn' trace event referencing the child.
    const parentEvents = store.listRunEvents({ runId: outcome.runId as string });
    const spawnEvents = parentEvents.filter((e) => e.kind === "spawn");
    expect(spawnEvents).toHaveLength(1);
    expect(spawnEvents[0]?.payload).toMatchObject({ data: { childRunId } });
  });

  test("a child runs under ONLY its descriptor caps, not the parent's (runtime narrowing)", async () => {
    // The slice's central security guarantee: a spawned child is gated by its
    // descriptor capability subset AT ITS OWN RUNTIME, not just at spawn time.
    // The parent holds CLI_INVOKE; the child is spawned WITHOUT it and then tries
    // to ctx.complete — the child's own context must DENY it. A regression here
    // (the child inheriting the parent's grant) silently re-opens capability
    // escalation, which is exactly what per-task grants exist to prevent.
    const complete: CompleteFn = async () => ({
      text: "x",
      exit_code: 0,
      raw_stdout: "x",
      raw_stderr: "",
      duration_ms: 1,
    });
    registry.register("child", async (ctx) => {
      // Granted only WRITE_STORAGE; CLI_INVOKE must be denied at the child gate.
      await ctx.complete("should be denied");
      ctx.recordRun({ status: "ok", summary: "should not be reached" });
    });
    let childError: unknown;
    registry.register("parent", async (ctx) => {
      const handle = ctx.spawn({
        handlerId: "child",
        label: "narrow",
        capabilities: ["WRITE_STORAGE"], // deliberately NOT CLI_INVOKE
      });
      try {
        await handle.done;
      } catch (err) {
        childError = err;
      }
      ctx.recordRun({ status: "partial", summary: "child was denied" });
    });

    const scheduler = new Scheduler({ db, registry, grants: CAPABILITIES, complete });
    scheduler.register({
      id: "parent",
      kind: "manual",
      schedule_expr: "",
      handler_id: "parent",
      // The parent itself CAN complete — the point is the child cannot inherit it.
      required_capabilities: ["SPAWN_SUBAGENT", "WRITE_STORAGE", "CLI_INVOKE"],
    });

    const outcome = await scheduler.run("parent");

    // The child's complete was denied at its OWN runtime capability gate.
    expect(childError).toBeInstanceOf(CapabilityError);
    // The child row is finalized 'error' (the denied complete bubbled), not 'ok'.
    const children = store.listRuns({ parentRunId: outcome.runId });
    expect(children).toHaveLength(1);
    expect(children[0]?.status).toBe("error");
  });
});
