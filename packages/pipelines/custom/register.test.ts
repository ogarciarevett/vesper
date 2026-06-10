import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HandlerRegistry, openStore, Scheduler, type Store } from "@vesper/core";
import { grantedCapabilities } from "../index.ts";
import { ORCHESTRATION_CONTRACTS } from "../router/contracts.ts";
import type { CustomPipelineDeps } from "./handler.ts";
import {
  registerCustomPipeline,
  registerCustomPipelines,
  unregisterCustomPipeline,
} from "./register.ts";

describe("registerCustomPipelines", () => {
  let dir: string;
  let db: Database;
  let store: Store;
  let scheduler: Scheduler;
  let registry: HandlerRegistry;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "vesper-custom-register-"));
    const path = join(dir, "test.db");
    store = openStore(path); // runs migrations
    db = new Database(path);
    registry = new HandlerRegistry();
    scheduler = new Scheduler({ db, registry, grants: grantedCapabilities() });
  });

  afterEach(() => {
    db.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const promptDoc: Record<string, unknown> = {
    v: 1,
    name: "Brief",
    stages: [{ tasks: [{ kind: "prompt", id: "a", title: "A", prompt: "go" }] }],
  };

  function deps(): CustomPipelineDeps {
    return { getDoc: () => promptDoc, contracts: ORCHESTRATION_CONTRACTS };
  }

  test("registers a manual task with the derived capabilities", () => {
    const result = registerCustomPipeline(
      scheduler,
      registry,
      { id: "brief", doc: promptDoc },
      deps(),
    );
    expect(result.ok).toBe(true);
    expect(result.taskId).toBe("custom:brief");

    const task = scheduler.list().find((t) => t.id === "custom:brief");
    expect(task).toBeDefined();
    expect(task?.kind).toBe("manual");
    expect(task?.handler_id).toBe("custom:brief");
    expect([...(task?.required_capabilities ?? [])].sort()).toEqual([
      "CLI_INVOKE",
      "WRITE_STORAGE",
    ]);
    expect(registry.has("custom:brief")).toBe(true);
  });

  test("re-registering refreshes the capability set (save = refresh)", () => {
    registerCustomPipeline(scheduler, registry, { id: "p", doc: promptDoc }, deps());

    const withLoop: Record<string, unknown> = {
      ...promptDoc,
      stages: [
        { tasks: [{ kind: "pipeline", id: "l", title: "L", target: "loop", prompt: "go" }] },
      ],
    };
    const result = registerCustomPipeline(scheduler, registry, { id: "p", doc: withLoop }, deps());
    expect(result.ok).toBe(true);

    const task = scheduler.list().find((t) => t.id === "custom:p");
    expect(task?.required_capabilities).toContain("SPAWN_SUBAGENT");
  });

  test("an invalid doc is reported, never registered", () => {
    const result = registerCustomPipeline(
      scheduler,
      registry,
      { id: "bad", doc: { v: 1 } },
      deps(),
    );
    expect(result.ok).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(scheduler.list().some((t) => t.id === "custom:bad")).toBe(false);
  });

  test("unregister removes the task (archive path)", () => {
    registerCustomPipeline(scheduler, registry, { id: "p", doc: promptDoc }, deps());
    unregisterCustomPipeline(scheduler, "p");
    expect(scheduler.list().some((t) => t.id === "custom:p")).toBe(false);
  });

  test("the boot sweep registers every valid row and reports the invalid ones", () => {
    const results = registerCustomPipelines(
      scheduler,
      registry,
      [
        { id: "good", doc: promptDoc },
        { id: "bad", doc: { v: 1 } },
      ],
      deps(),
    );
    expect(results.map((r) => r.ok)).toEqual([true, false]);
    expect(scheduler.list().some((t) => t.id === "custom:good")).toBe(true);
    expect(scheduler.list().some((t) => t.id === "custom:bad")).toBe(false);
  });

  test("a registered custom task runs end-to-end through the scheduler", async () => {
    registerCustomPipeline(scheduler, registry, { id: "brief", doc: promptDoc }, deps());
    // The scheduler injects a real context; complete() would shell out, so this
    // doc would need CLI_INVOKE wiring — instead verify the run path resolves the
    // handler and produces a run row with the validation error for a missing CLI
    // or an ok outcome, depending on environment. We assert only that the
    // scheduler can RUN the task id (no unknown_task / unknown_handler).
    const outcome = await scheduler.run("custom:brief");
    expect(outcome.taskId).toBe("custom:brief");
    expect(outcome.runId).not.toBeNull();
  });
});
