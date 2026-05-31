import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HandlerRegistry, openStore, type PipelineContext, Scheduler } from "@vesper/core";
import { grantedCapabilities, registerPipelines } from "../index.ts";
import { selftestHandler, selftestTaskInput } from "./handler.ts";

// ---------------------------------------------------------------------------
// Fake PipelineContext — captures calls without a real scheduler/CLI/storage.
// ---------------------------------------------------------------------------

interface CompleteCall {
  readonly prompt: string;
}

interface RecordedRun {
  readonly status: string;
  readonly summary: string;
}

interface FakeContext {
  readonly ctx: PipelineContext;
  readonly completeCalls: CompleteCall[];
  readonly recordedRuns: RecordedRun[];
}

/**
 * Build a fake {@link PipelineContext} that records the prompts passed to
 * `complete` and the runs passed to `recordRun`, returning a canned completion.
 * No real CLI is invoked and no storage is touched.
 */
function makeFakeContext(options: {
  readonly params?: Record<string, unknown>;
  readonly text?: string;
  readonly exitCode?: number;
}): FakeContext {
  const completeCalls: CompleteCall[] = [];
  const recordedRuns: RecordedRun[] = [];
  const text = options.text ?? "ok";
  const exitCode = options.exitCode ?? 0;

  const ctx: PipelineContext = {
    task: {
      id: "selftest",
      kind: "manual",
      schedule_expr: "",
      handler_id: "selftest",
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
      required_capabilities: ["CLI_INVOKE", "WRITE_STORAGE"],
    },
    now: new Date(2025, 0, 1, 0, 0, 0, 0),
    params: options.params ?? {},
    runId: "run-id",
    parentRunId: null,
    async complete(prompt) {
      completeCalls.push({ prompt });
      return {
        text,
        exit_code: exitCode,
        raw_stdout: text,
        raw_stderr: "",
        duration_ms: 1,
      };
    },
    recordRun({ status, summary }) {
      recordedRuns.push({ status, summary });
      return "run-id";
    },
    emitProgress() {},
    spawn() {
      throw new Error("spawn is not supported in this fake context");
    },
  };

  return { ctx, completeCalls, recordedRuns };
}

// ---------------------------------------------------------------------------
// selftestHandler
// ---------------------------------------------------------------------------

describe("selftestHandler", () => {
  test("GIVEN a non-empty prompt param THEN that prompt is sent to complete", async () => {
    const fake = makeFakeContext({ params: { prompt: "hello there" } });

    await selftestHandler(fake.ctx);

    expect(fake.completeCalls).toHaveLength(1);
    expect(fake.completeCalls[0]?.prompt).toBe("hello there");
  });

  test("GIVEN a missing prompt param THEN the default self-test prompt is used", async () => {
    const fake = makeFakeContext({});

    await selftestHandler(fake.ctx);

    expect(fake.completeCalls).toHaveLength(1);
    const prompt = fake.completeCalls[0]?.prompt ?? "";
    expect(prompt).toContain("Vesper self-test pipeline");
    expect(prompt.length).toBeGreaterThan(0);
  });

  test("GIVEN a blank prompt param THEN the default self-test prompt is used", async () => {
    const fake = makeFakeContext({ params: { prompt: "   " } });

    await selftestHandler(fake.ctx);

    expect(fake.completeCalls[0]?.prompt).toContain("Vesper self-test pipeline");
  });

  test("GIVEN a non-string prompt param THEN the default self-test prompt is used", async () => {
    const fake = makeFakeContext({ params: { prompt: 42 } });

    await selftestHandler(fake.ctx);

    expect(fake.completeCalls[0]?.prompt).toContain("Vesper self-test pipeline");
  });

  test("summary is the trimmed completion text", async () => {
    const fake = makeFakeContext({ text: "  spaced response  " });

    await selftestHandler(fake.ctx);

    expect(fake.recordedRuns).toHaveLength(1);
    expect(fake.recordedRuns[0]?.summary).toBe("spaced response");
  });

  test("summary is truncated to at most 500 chars for long responses", async () => {
    const longText = "x".repeat(750);
    const fake = makeFakeContext({ text: longText });

    await selftestHandler(fake.ctx);

    expect(fake.recordedRuns[0]?.summary).toHaveLength(500);
  });

  test("status is 'ok' when exit_code is 0", async () => {
    const fake = makeFakeContext({ exitCode: 0 });

    await selftestHandler(fake.ctx);

    expect(fake.recordedRuns[0]?.status).toBe("ok");
  });

  test("status is 'error' when exit_code is non-zero", async () => {
    const fake = makeFakeContext({ exitCode: 1 });

    await selftestHandler(fake.ctx);

    expect(fake.recordedRuns[0]?.status).toBe("error");
  });

  test("GIVEN exit 0 but empty output THEN status is 'error' with a placeholder summary", async () => {
    const fake = makeFakeContext({ exitCode: 0, text: "   " });

    await selftestHandler(fake.ctx);

    expect(fake.recordedRuns[0]?.status).toBe("error");
    expect(fake.recordedRuns[0]?.summary).toBe("(empty response)");
  });
});

// ---------------------------------------------------------------------------
// registerPipelines — real HandlerRegistry + Scheduler on a temp-file DB.
// ---------------------------------------------------------------------------

describe("registerPipelines", () => {
  let dir: string;
  let dbPath: string;
  let db: Database;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "vesper-pipelines-"));
    dbPath = join(dir, "vesper.sqlite");
    // openStore migrates the schema; close it so we can reopen a raw connection.
    openStore(dbPath).close();
    db = new Database(dbPath);
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("registers the selftest handler and a manual selftest task with the right capabilities", () => {
    const registry = new HandlerRegistry();
    // Match the production wiring (daemon-run.ts): the host union is the grant
    // ceiling, so built-ins register cleanly (their caps are a subset by construction).
    const scheduler = new Scheduler({ db, registry, grants: grantedCapabilities() });

    registerPipelines(scheduler, registry);

    expect(registry.has("selftest")).toBe(true);

    const selftestTask = scheduler.list().find((task) => task.id === "selftest");
    expect(selftestTask).toBeDefined();
    expect(selftestTask?.required_capabilities).toContain("CLI_INVOKE");
    expect(selftestTask?.required_capabilities).toContain("WRITE_STORAGE");
  });

  test("is idempotent — calling twice does not throw and yields a single selftest task", () => {
    const registry = new HandlerRegistry();
    const scheduler = new Scheduler({ db, registry, grants: grantedCapabilities() });

    registerPipelines(scheduler, registry);
    expect(() => registerPipelines(scheduler, registry)).not.toThrow();

    const selftestTasks = scheduler.list().filter((task) => task.id === "selftest");
    expect(selftestTasks).toHaveLength(1);
  });
});

describe("grantedCapabilities", () => {
  test("is the deduplicated union of every registered pipeline's required capabilities", () => {
    const granted = grantedCapabilities();
    // Every registered pipeline's declared capability must be covered by the grant.
    for (const cap of selftestTaskInput.required_capabilities ?? []) {
      expect(granted).toContain(cap);
    }
    // No duplicates.
    expect(new Set(granted).size).toBe(granted.length);
  });
});
