import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HandlerRegistry, openStore, Scheduler, type Store } from "@vesper/core";
import { grantedCapabilities, registerPipelines } from "../index.ts";
import { DEMO_WORKER_HANDLER_ID, demoWorkerHandler } from "./handler.ts";

describe("orchestrator-demo pipeline", () => {
  let path: string;
  let db: Database;
  let store: Store;
  let registry: HandlerRegistry;
  let scheduler: Scheduler;

  beforeEach(() => {
    // Mirror the daemon's wiring (daemon-run.ts): migrate the file once, give the
    // scheduler its own Database connection, and read back via a second openStore.
    path = join(tmpdir(), `vesper-test-${crypto.randomUUID()}.db`);
    openStore(path).close();
    db = new Database(path);
    store = openStore(path);
    registry = new HandlerRegistry();
    scheduler = new Scheduler({ db, registry, grants: grantedCapabilities() });
    registerPipelines(scheduler, registry);
  });

  afterEach(() => {
    db.close();
    store.close();
    try {
      rmSync(path, { force: true });
      rmSync(`${path}-shm`, { force: true });
      rmSync(`${path}-wal`, { force: true });
    } catch {
      // ignore
    }
  });

  test("registers a runnable orchestrator task plus a spawn-only worker handler", () => {
    // The orchestrator is a manual task; the worker is registered as a handler but
    // is NOT a scheduled task (spawn-only).
    const ids = scheduler.list().map((t) => t.id);
    expect(ids).toContain("orchestrator-demo");
    expect(ids).not.toContain(DEMO_WORKER_HANDLER_ID);
    // The worker handler resolves (so ctx.spawn can find it); unknown ids throw.
    expect(() => registry.get(DEMO_WORKER_HANDLER_ID)).not.toThrow();
  });

  test("the host grant union includes SPAWN_SUBAGENT (orchestrator declares it)", () => {
    expect(grantedCapabilities()).toContain("SPAWN_SUBAGENT");
  });

  test("running it fans out 3 sub-agents, each with its own live trace under the parent", async () => {
    const outcome = await scheduler.run("orchestrator-demo", { params: { instant: true } });

    expect(outcome.status).toBe("ok");
    expect(outcome.summary).toBe("3/3 sub-agents finished");
    expect(outcome.runId).not.toBeNull();

    // Three child rows, parented to the run, each finished 'ok'.
    const children = store.listRuns({ parentRunId: outcome.runId });
    expect(children).toHaveLength(3);
    expect(children.map((c) => c.pipeline)).toEqual([
      DEMO_WORKER_HANDLER_ID,
      DEMO_WORKER_HANDLER_ID,
      DEMO_WORKER_HANDLER_ID,
    ]);
    for (const child of children) {
      expect(child.parentRunId).toBe(outcome.runId as string);
      expect(child.status).toBe("ok");
    }

    // The parent recorded 'spawn' trace events; each child recorded its own steps.
    const parentEvents = store.listRunEvents({ runId: outcome.runId as string });
    expect(parentEvents.filter((e) => e.kind === "spawn")).toHaveLength(3);

    for (const child of children) {
      const childEvents = store.listRunEvents({ runId: child.id });
      // step(starting) + progress(working) + step(done) + complete = 4
      expect(childEvents.length).toBeGreaterThanOrEqual(3);
      expect(childEvents.some((e) => e.kind === "progress")).toBe(true);
    }

    // The tree the UI renders has the parent + 3 children.
    const tree = store.runTree(outcome.runId as string);
    expect(tree?.children).toHaveLength(3);
  });

  test("the worker handler reads its stage from descriptor params (params reach the child)", async () => {
    // Direct unit check of the worker: descriptor params surface as ctx.params.
    const recorded: Array<{ status: string; summary: string }> = [];
    const events: string[] = [];
    await demoWorkerHandler({
      task: {
        id: DEMO_WORKER_HANDLER_ID,
        kind: "manual",
        schedule_expr: "",
        handler_id: DEMO_WORKER_HANDLER_ID,
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
        required_capabilities: ["WRITE_STORAGE"],
      },
      now: new Date(),
      params: { stage: "research", instant: true },
      runId: "child-1",
      parentRunId: "parent-1",
      complete: async () => {
        throw new Error("unused");
      },
      recordRun({ status, summary }) {
        recorded.push({ status, summary });
        return "child-1";
      },
      emitProgress(e) {
        events.push(e.message);
      },
      spawn: () => {
        throw new Error("unused");
      },
      readSignals: () => {
        throw new Error("unused");
      },
      notify: async () => ({ delivered: false }),
    });

    expect(recorded).toEqual([{ status: "ok", summary: "research complete" }]);
    expect(events[0]).toBe("research: starting");
  });
});
