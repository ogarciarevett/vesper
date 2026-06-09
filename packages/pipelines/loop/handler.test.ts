/**
 * Tests for the `loop` pipeline handler — param validation/clamping, the
 * fail-fast goal gate (no CLI call), and the wiring into `runLoop`. The fake
 * `ctx` mocks `complete`; the suite shells out to nothing.
 */

import { describe, expect, test } from "bun:test";
import type { AppendEventInput, PipelineContext } from "@vesper/core";
import { buildLoopSpec, createLoopHandler, LOOP_HANDLER_ID, loopTaskInput } from "./handler.ts";

/** A critic reply that succeeds immediately. */
const DONE_VERDICT = '```json\n{ "done": true, "progress": 100, "feedback": "met" }\n```';

function makeCtx(params: Record<string, unknown>): {
  ctx: PipelineContext;
  completeCalls: string[];
  recorded: { status: string; summary: string }[];
} {
  const completeCalls: string[] = [];
  const recorded: { status: string; summary: string }[] = [];
  const ctx = {
    task: {
      id: "loop",
      kind: "manual",
      schedule_expr: "",
      handler_id: LOOP_HANDLER_ID,
      enabled: true,
      last_run_at: null,
      last_error: null,
      max_runs_per_day: null,
      max_concurrent: null,
      max_duration_ms: 1_800_000,
      runs_today: 0,
      runs_today_date: null,
      attempt_count: 0,
      next_attempt_at: null,
      required_capabilities: ["CLI_INVOKE", "WRITE_STORAGE"],
    },
    now: new Date(2026, 0, 1),
    params,
    runId: "run-id",
    parentRunId: null,
    async complete(prompt: string) {
      completeCalls.push(prompt);
      // Role by position: author, execute, critic (succeed on the first critic).
      const role = (completeCalls.length - 1) % 3;
      const text = role === 2 ? DONE_VERDICT : `text ${completeCalls.length}`;
      return { text, exit_code: 0, raw_stdout: text, raw_stderr: "", duration_ms: 1 };
    },
    recordRun({ status, summary }: { status: string; summary: string }) {
      recorded.push({ status, summary });
      return "run-id";
    },
    emitProgress() {},
  } as unknown as PipelineContext;
  return { ctx, completeCalls, recorded };
}

function makeDeps(): { appendEvent: LoopHandlerDepsAppend; events: AppendEventInput[] } {
  const events: AppendEventInput[] = [];
  return {
    appendEvent: (input: AppendEventInput) => {
      events.push(input);
      return `evt-${events.length}`;
    },
    events,
  };
}
type LoopHandlerDepsAppend = (input: AppendEventInput) => string;

describe("buildLoopSpec", () => {
  test("requires a non-empty goal", () => {
    expect(() => buildLoopSpec({})).toThrow(/goal/);
    expect(() => buildLoopSpec({ goal: "   " })).toThrow(/goal/);
    expect(() => buildLoopSpec({ goal: 42 })).toThrow(/goal/);
  });

  test("applies defaults and clamps maxIterations to the ceiling", () => {
    expect(buildLoopSpec({ goal: "g" }).bounds.maxIterations).toBe(8);
    expect(buildLoopSpec({ goal: "g", maxIterations: "999" }).bounds.maxIterations).toBe(50);
    expect(buildLoopSpec({ goal: "g", maxIterations: 3 }).bounds.maxIterations).toBe(3);
    // Non-positive/garbage values fall back to the default.
    expect(buildLoopSpec({ goal: "g", maxIterations: "-2" }).bounds.maxIterations).toBe(8);
  });

  test("threads criteria, bounds, and per-role CLI overrides", () => {
    const spec = buildLoopSpec({
      goal: "g",
      successCriteria: "c",
      maxNoProgress: "3",
      maxTotalMs: 60_000,
      authorCli: "claude",
      criticCli: "codex",
    });
    expect(spec.objective.successCriteria).toBe("c");
    expect(spec.bounds.maxNoProgress).toBe(3);
    expect(spec.bounds.maxTotalMs).toBe(60_000);
    expect(spec.roles?.authorCli).toBe("claude");
    expect(spec.roles?.executeCli).toBeUndefined();
    expect(spec.roles?.criticCli).toBe("codex");
  });
});

describe("loopHandler", () => {
  test("a missing goal fails fast with zero CLI calls", async () => {
    const { ctx, completeCalls } = makeCtx({});
    const handler = createLoopHandler(makeDeps());

    await expect(handler(ctx)).rejects.toThrow(/goal/);
    expect(completeCalls).toHaveLength(0);
  });

  test("runs the loop and records the run + per-iteration audit row", async () => {
    const { ctx, completeCalls, recorded } = makeCtx({ goal: "answer the question" });
    const deps = makeDeps();
    const handler = createLoopHandler(deps);

    await handler(ctx);

    expect(completeCalls).toHaveLength(3); // one iteration: author, execute, critic(done)
    expect(recorded[0]?.status).toBe("succeeded");
    expect(deps.events).toHaveLength(1);
    expect(deps.events[0]?.source).toBe("loop");
    expect(deps.events[0]?.kind).toBe("loop_iteration");
  });
});

describe("loopTaskInput", () => {
  test("declares exactly CLI_INVOKE + WRITE_STORAGE (the v1 safety boundary)", () => {
    expect([...(loopTaskInput.required_capabilities ?? [])].sort()).toEqual([
      "CLI_INVOKE",
      "WRITE_STORAGE",
    ]);
    expect(loopTaskInput.kind).toBe("manual");
    expect(loopTaskInput.handler_id).toBe(LOOP_HANDLER_ID);
  });
});
