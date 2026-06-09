/**
 * Tests for the autonomous-loop engine. `ctx.complete` is a mock — the suite
 * shells out to nothing. Roles are inferred by call position: each iteration is
 * exactly three complete calls in order (AUTHOR, EXECUTE, CRITIC).
 */

import { describe, expect, test } from "bun:test";
import type { PipelineContext, ProgressEvent } from "../scheduler/types.ts";
import type { AppendEventInput } from "../storage/types.ts";
import { runLoop } from "./engine.ts";
import type { LoopSpec } from "./types.ts";

/** Build a fenced critic verdict reply. */
function verdictReply(verdict: { done?: boolean; progress?: number; feedback?: string }): string {
  return `\`\`\`json\n${JSON.stringify({ done: false, progress: 0, feedback: "keep going", ...verdict })}\n\`\`\``;
}

interface CompleteCall {
  readonly prompt: string;
  readonly cli: string | undefined;
}

interface FakeLoopCtx {
  readonly ctx: PipelineContext;
  readonly calls: CompleteCall[];
  readonly progress: ProgressEvent[];
  readonly recorded: { status: string; summary: string }[];
}

/**
 * Fake context whose CRITIC replies come from `criticReplies` by iteration
 * (the last entry repeats when iterations outnumber entries). AUTHOR replies
 * "authored prompt N", EXECUTE replies "execution result N".
 */
function makeCtx(criticReplies: readonly string[]): FakeLoopCtx {
  const calls: CompleteCall[] = [];
  const progress: ProgressEvent[] = [];
  const recorded: { status: string; summary: string }[] = [];

  const ctx = {
    task: {
      id: "loop",
      kind: "manual",
      schedule_expr: "",
      handler_id: "loop",
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
    now: new Date(2026, 0, 1),
    params: {},
    runId: "run-id",
    parentRunId: null,
    async complete(prompt: string, opts?: { readonly cli?: string }) {
      calls.push({ prompt, cli: opts?.cli });
      const role = (calls.length - 1) % 3;
      const iteration = Math.ceil(calls.length / 3);
      let text: string;
      if (role === 0) text = `authored prompt ${iteration}`;
      else if (role === 1) text = `execution result ${iteration}`;
      else text = criticReplies[Math.min(iteration - 1, criticReplies.length - 1)] ?? "";
      return { text, exit_code: 0, raw_stdout: text, raw_stderr: "", duration_ms: 1 };
    },
    recordRun({ status, summary }: { status: string; summary: string }) {
      recorded.push({ status, summary });
      return "run-id";
    },
    emitProgress(event: ProgressEvent) {
      progress.push(event);
    },
    spawn() {
      throw new Error("spawn unsupported in this fake");
    },
    readSignals() {
      throw new Error("readSignals unsupported in this fake");
    },
    async notify() {
      return { delivered: false as const, reason: "unavailable" as const };
    },
  } as unknown as PipelineContext;

  return { ctx, calls, progress, recorded };
}

function spec(overrides: Partial<LoopSpec["bounds"]> = {}, goal = "reach the objective"): LoopSpec {
  return {
    objective: { goal },
    bounds: { maxIterations: 8, ...overrides },
  };
}

describe("runLoop bounds", () => {
  test("a never-done critic exhausts at maxIterations, never unbounded", async () => {
    // Progress strictly improves every iteration so the stall detector never fires.
    const replies = [10, 20, 30].map((p) => verdictReply({ progress: p }));
    const { ctx, calls } = makeCtx(replies);

    const result = await runLoop(ctx, spec({ maxIterations: 3, maxNoProgress: 99 }));

    expect(result.status).toBe("exhausted");
    expect(result.iterations).toHaveLength(3);
    expect(calls).toHaveLength(9); // 3 roles x 3 iterations, not one more
  });

  test("done on iteration k stops at k with no k+1 author call", async () => {
    const replies = [
      verdictReply({ progress: 40 }),
      verdictReply({ done: true, progress: 100, feedback: "objective met" }),
    ];
    const { ctx, calls } = makeCtx(replies);

    const result = await runLoop(ctx, spec({ maxIterations: 8 }));

    expect(result.status).toBe("succeeded");
    expect(result.iterations).toHaveLength(2);
    expect(calls).toHaveLength(6);
    expect(result.finalOutput).toBe("execution result 2");
  });

  test("no critic progress for maxNoProgress iterations stalls", async () => {
    // 10, 10, 10: iteration 2 and 3 fail to improve on the best (10) -> stalled.
    const { ctx } = makeCtx([verdictReply({ progress: 10 })]);

    const result = await runLoop(ctx, spec({ maxIterations: 8, maxNoProgress: 2 }));

    expect(result.status).toBe("stalled");
    expect(result.iterations).toHaveLength(3);
  });

  test("the wall-clock budget aborts the loop", async () => {
    const { ctx } = makeCtx([verdictReply({ progress: 10 })]);
    let clock = 0;
    const result = await runLoop(
      ctx,
      spec({ maxIterations: 8, maxNoProgress: 99, maxTotalMs: 50 }),
      {
        now: () => {
          clock += 20; // each check advances 20ms; the budget trips after iteration 1's checks
          return clock;
        },
      },
    );

    expect(result.status).toBe("aborted");
    expect(result.iterations.length).toBeLessThan(8);
  });

  test("maxIterations above the ceiling is clamped to 50", async () => {
    // Strictly-improving progress (clamped at 100 only at the very end) so no stall.
    const replies = Array.from({ length: 50 }, (_, i) => verdictReply({ progress: i + 1 }));
    const { ctx, calls } = makeCtx(replies);

    const result = await runLoop(ctx, spec({ maxIterations: 999, maxNoProgress: 99 }));

    expect(result.status).toBe("exhausted");
    expect(result.iterations).toHaveLength(50);
    expect(calls).toHaveLength(150);
  });
});

describe("runLoop fail-closed critic", () => {
  test("a malformed critic verdict is no-progress, never success", async () => {
    const { ctx } = makeCtx(["this is not json at all"]);

    const result = await runLoop(ctx, spec({ maxIterations: 8, maxNoProgress: 2 }));

    expect(result.status).toBe("stalled"); // garbage counts as a stall, not a win
    expect(result.status).not.toBe("succeeded");
    const verdict = result.iterations[0]?.verdict;
    expect(verdict?.done).toBe(false);
    expect(verdict?.feedback).toBe("unparseable critic verdict");
  });
});

describe("runLoop observability", () => {
  test("each iteration emits the three role steps and exactly one audit row", async () => {
    const { ctx, progress } = makeCtx([
      verdictReply({ progress: 30 }),
      verdictReply({ done: true, progress: 100 }),
    ]);
    const events: AppendEventInput[] = [];

    await runLoop(ctx, spec(), {
      appendEvent: (input) => {
        events.push(input);
        return `evt-${events.length}`;
      },
    });

    // Live trace: step (author), log (execute), progress (critic) per iteration.
    expect(progress.map((p) => p.kind)).toEqual([
      "step",
      "log",
      "progress",
      "step",
      "log",
      "progress",
    ]);

    // Audit: one events row per iteration, metadata granularity only.
    expect(events).toHaveLength(2);
    for (const event of events) {
      expect(event.source).toBe("loop");
      expect(event.kind).toBe("loop_iteration");
      expect(Object.keys(event.payload).sort()).toEqual([
        "done",
        "iteration",
        "progress",
        "status",
      ]);
      const serialized = JSON.stringify(event.payload);
      expect(serialized).not.toContain("authored prompt");
      expect(serialized).not.toContain("execution result");
    }
    expect(events[0]?.payload.status).toBe("continue");
    expect(events[1]?.payload.status).toBe("succeeded");
  });

  test("the run is recorded with the terminal status and an iteration count", async () => {
    const { ctx, recorded } = makeCtx([verdictReply({ done: true, progress: 100 })]);

    await runLoop(ctx, spec());

    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.status).toBe("succeeded");
    expect(recorded[0]?.summary).toContain("succeeded after 1 iteration(s)");
    expect(recorded[0]?.summary).toContain("execution result 1");
  });

  test("per-role CLI overrides reach complete in author/execute/critic order", async () => {
    const { ctx, calls } = makeCtx([verdictReply({ done: true, progress: 100 })]);

    await runLoop(ctx, {
      objective: { goal: "g" },
      roles: { authorCli: "claude", executeCli: "gemini", criticCli: "codex" },
      bounds: { maxIterations: 2 },
    });

    expect(calls.map((c) => c.cli)).toEqual(["claude", "gemini", "codex"]);
  });

  test("the author prompt carries the goal, criteria, and prior critic feedback", async () => {
    const { ctx, calls } = makeCtx([
      verdictReply({ progress: 25, feedback: "narrow the scope" }),
      verdictReply({ done: true, progress: 100 }),
    ]);

    await runLoop(ctx, {
      objective: { goal: "summarize the design", successCriteria: "three bullet points" },
      bounds: { maxIterations: 3 },
    });

    const firstAuthor = calls[0]?.prompt ?? "";
    expect(firstAuthor).toContain("summarize the design");
    expect(firstAuthor).toContain("three bullet points");
    const secondAuthor = calls[3]?.prompt ?? "";
    expect(secondAuthor).toContain("narrow the scope");
    expect(secondAuthor).toContain("authored prompt 1");
    // The executed prompt is the authored text verbatim.
    expect(calls[1]?.prompt).toBe("authored prompt 1");
  });
});

describe("runLoop fail-fast", () => {
  test("an empty goal throws before any CLI call", async () => {
    const { ctx, calls } = makeCtx([]);

    await expect(runLoop(ctx, spec({}, "   "))).rejects.toThrow(/goal/);
    expect(calls).toHaveLength(0);
  });
});
