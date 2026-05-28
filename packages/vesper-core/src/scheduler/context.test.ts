import { describe, expect, test } from "bun:test";
import { CapabilityError } from "../capabilities/errors.ts";
import { CLIError } from "../cli/errors.ts";
import type { CompleteResult } from "../cli/types.ts";
import type { RecordRunInput, Store } from "../storage/types.ts";
import { buildPipelineContext, redactSummary } from "./context.ts";
import type { Capability, CompleteFn, ScheduledTask } from "./types.ts";

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

function makeTask(capabilities: readonly Capability[]): ScheduledTask {
  return {
    id: "echo",
    kind: "manual",
    schedule_expr: "",
    handler_id: "echo",
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
    required_capabilities: capabilities,
  };
}

function makeResult(text: string): CompleteResult {
  return { text, exit_code: 0, raw_stdout: text, raw_stderr: "", duration_ms: 1 };
}

/** Store double that captures recordRun calls. */
function makeStore(): { store: Store; recorded: RecordRunInput[] } {
  const recorded: RecordRunInput[] = [];
  const store: Store = {
    migrate() {},
    appendEvent() {
      return "evt";
    },
    listEvents() {
      return [];
    },
    recordRun(input) {
      recorded.push(input);
      return "run-id";
    },
    listRuns() {
      return [];
    },
    close() {},
  };
  return { store, recorded };
}

const NOW = new Date("2026-05-28T12:00:00.000Z");

// ---------------------------------------------------------------------------
// params
// ---------------------------------------------------------------------------

describe("buildPipelineContext params", () => {
  test("defaults to an empty object when no options given", () => {
    const { store } = makeStore();
    const ctx = buildPipelineContext({ task: makeTask([]), now: NOW, store });
    expect(ctx.params).toEqual({});
    expect(ctx.now).toBe(NOW);
    expect(ctx.task.id).toBe("echo");
  });

  test("surfaces transient run params", () => {
    const { store } = makeStore();
    const ctx = buildPipelineContext({
      task: makeTask([]),
      now: NOW,
      store,
      options: { params: { prompt: "hello" } },
    });
    expect(ctx.params).toEqual({ prompt: "hello" });
  });
});

// ---------------------------------------------------------------------------
// complete — capability gate + resolution
// ---------------------------------------------------------------------------

describe("buildPipelineContext.complete", () => {
  test("throws CapabilityError when CLI_INVOKE is not declared", async () => {
    const { store } = makeStore();
    const ctx = buildPipelineContext({
      task: makeTask(["WRITE_STORAGE"]),
      now: NOW,
      store,
      complete: async () => makeResult("unused"),
    });
    await expect(ctx.complete("hi")).rejects.toBeInstanceOf(CapabilityError);
  });

  test("does not invoke the resolver when the capability is denied", async () => {
    const { store } = makeStore();
    let calls = 0;
    const complete: CompleteFn = async () => {
      calls++;
      return makeResult("x");
    };
    const ctx = buildPipelineContext({ task: makeTask([]), now: NOW, store, complete });
    await expect(ctx.complete("hi")).rejects.toBeInstanceOf(CapabilityError);
    expect(calls).toBe(0);
  });

  test("throws CLIError when no resolver is configured", async () => {
    const { store } = makeStore();
    const ctx = buildPipelineContext({ task: makeTask(["CLI_INVOKE"]), now: NOW, store });
    await expect(ctx.complete("hi")).rejects.toBeInstanceOf(CLIError);
  });

  test("passes the prompt through and returns the result", async () => {
    const { store } = makeStore();
    let seen = "";
    const complete: CompleteFn = async (prompt) => {
      seen = prompt;
      return makeResult("pong");
    };
    const ctx = buildPipelineContext({
      task: makeTask(["CLI_INVOKE"]),
      now: NOW,
      store,
      complete,
    });
    const result = await ctx.complete("ping");
    expect(seen).toBe("ping");
    expect(result.text).toBe("pong");
  });

  test("explicit opts.cli wins over the run-override", async () => {
    const { store } = makeStore();
    let resolvedCli: string | undefined;
    const complete: CompleteFn = async (_prompt, opts) => {
      resolvedCli = opts?.cli;
      return makeResult("ok");
    };
    const ctx = buildPipelineContext({
      task: makeTask(["CLI_INVOKE"]),
      now: NOW,
      store,
      complete,
      options: { cli: "gemini" },
    });
    await ctx.complete("p", { cli: "codex" });
    expect(resolvedCli).toBe("codex");
  });

  test("falls back to the run-override when opts.cli is omitted", async () => {
    const { store } = makeStore();
    let resolvedCli: string | undefined = "sentinel";
    const complete: CompleteFn = async (_prompt, opts) => {
      resolvedCli = opts?.cli;
      return makeResult("ok");
    };
    const ctx = buildPipelineContext({
      task: makeTask(["CLI_INVOKE"]),
      now: NOW,
      store,
      complete,
      options: { cli: "claude" },
    });
    await ctx.complete("p");
    expect(resolvedCli).toBe("claude");
  });

  test("passes no cli when neither override is set (resolver picks default)", async () => {
    const { store } = makeStore();
    let opts: { cli?: string } | undefined = { cli: "sentinel" };
    const complete: CompleteFn = async (_prompt, o) => {
      opts = o;
      return makeResult("ok");
    };
    const ctx = buildPipelineContext({
      task: makeTask(["CLI_INVOKE"]),
      now: NOW,
      store,
      complete,
    });
    await ctx.complete("p");
    expect(opts?.cli).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// recordRun — capability gate + persistence
// ---------------------------------------------------------------------------

describe("buildPipelineContext.recordRun", () => {
  test("throws CapabilityError when WRITE_STORAGE is not declared", () => {
    const { store, recorded } = makeStore();
    const ctx = buildPipelineContext({ task: makeTask(["CLI_INVOKE"]), now: NOW, store });
    expect(() => ctx.recordRun({ status: "ok", summary: "s" })).toThrow(CapabilityError);
    expect(recorded).toHaveLength(0);
  });

  test("records a run keyed by the task handler id", () => {
    const { store, recorded } = makeStore();
    const ctx = buildPipelineContext({
      task: makeTask(["WRITE_STORAGE"]),
      now: NOW,
      store,
    });
    const id = ctx.recordRun({ status: "ok", summary: "done" });
    expect(id).toBe("run-id");
    expect(recorded).toEqual([{ pipeline: "echo", status: "ok", summary: "done" }]);
  });

  test("redacts the summary to size-only metadata when redactSummaries is set", () => {
    const { store, recorded } = makeStore();
    const ctx = buildPipelineContext({
      task: makeTask(["WRITE_STORAGE"]),
      now: NOW,
      store,
      redactSummaries: true,
    });
    ctx.recordRun({ status: "ok", summary: "sensitive raw output" });
    // Status kept verbatim; only the free-text summary is redacted.
    expect(recorded[0]?.status).toBe("ok");
    expect(recorded[0]?.summary).toBe("[redacted: 20 chars]");
    expect(recorded[0]?.summary).not.toContain("sensitive");
  });
});

describe("redactSummary", () => {
  test("replaces content with a size-only marker", () => {
    expect(redactSummary("hello")).toBe("[redacted: 5 chars]");
    expect(redactSummary("")).toBe("[redacted: 0 chars]");
  });
});
