import { describe, expect, test } from "bun:test";
import { CapabilityError } from "../capabilities/errors.ts";
import { CLIError } from "../cli/errors.ts";
import type { CompleteResult } from "../cli/types.ts";
import type {
  AppendRunEventInput,
  FinishRunInput,
  RecordRunContextInput,
  RunEventRow,
  Store,
} from "../storage/types.ts";
import { buildPipelineContext, contextWindowFor, redactSummary } from "./context.ts";
import { EventBus, RUN_EVENT } from "./events.ts";
import type {
  Capability,
  CompleteFn,
  NotifyFn,
  NotifyIntent,
  PipelineContext,
  ScheduledTask,
  SubAgentHandle,
} from "./types.ts";

const RUN_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

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

/**
 * Store double that captures the writes the context performs. The scheduler now
 * drives the context through `startRun` + `finishRun` (not `recordRun`), so the
 * double records `finishRun` and `appendRunEvent` calls.
 */
function makeStore(): {
  store: Store;
  finished: FinishRunInput[];
  events: AppendRunEventInput[];
  contexts: RecordRunContextInput[];
  clis: { runId: string; cli: string }[];
} {
  const finished: FinishRunInput[] = [];
  const events: AppendRunEventInput[] = [];
  const contexts: RecordRunContextInput[] = [];
  const clis: { runId: string; cli: string }[] = [];
  const store: Store = {
    migrate() {},
    appendEvent() {
      return "evt";
    },
    listEvents() {
      return [];
    },
    recordRun() {
      return "run-id";
    },
    startRun() {
      return RUN_ID;
    },
    finishRun(input) {
      finished.push(input);
    },
    recordRunContext(input) {
      contexts.push(input);
    },
    recordRunCli(runId, cli) {
      clis.push({ runId, cli });
    },
    appendRunEvent(input) {
      events.push(input);
      return "evt-id";
    },
    listRunEvents(): RunEventRow[] {
      return [];
    },
    runTree() {
      return null;
    },
    listRuns() {
      return [];
    },
    upsertTaskGrant() {},
    getTaskGrant() {
      return null;
    },
    // Chat-home Store methods (migration 007): unused by the context double, stubbed
    // so the mock still satisfies the widened Store interface.
    createSession() {
      return "session-id";
    },
    appendTurn() {
      return "turn-id";
    },
    listSessions() {
      return [];
    },
    listTurns() {
      return [];
    },
    getTemplate() {
      return null;
    },
    upsertTemplate() {},
    // RAG Store methods (migrations 009/010): unused by the context double, stubbed
    // so the mock still satisfies the widened Store interface.
    ragDocumentCount() {
      return 0;
    },
    upsertRagDocument() {},
    listRagVectors() {
      return [];
    },
    pruneRagDocuments() {
      return 0;
    },
    // Benchmark Store methods (migration 012): unused by the context double.
    replaceModelBenchmarks() {
      return 0;
    },
    getModelBenchmarks() {
      return [];
    },
    close() {},
  };
  return { store, finished, events, contexts, clis };
}

const NOW = new Date("2026-05-28T12:00:00.000Z");

/**
 * Thin wrapper that injects the now-required `runId`/`parentRunId` deps so the
 * existing tests stay focused on the gated method under test.
 */
function build(deps: Omit<Parameters<typeof buildPipelineContext>[0], "runId" | "parentRunId">) {
  return buildPipelineContext({ runId: RUN_ID, parentRunId: null, ...deps });
}

// ---------------------------------------------------------------------------
// params
// ---------------------------------------------------------------------------

describe("buildPipelineContext params", () => {
  test("defaults to an empty object when no options given", () => {
    const { store } = makeStore();
    const ctx = build({ task: makeTask([]), now: NOW, store });
    expect(ctx.params).toEqual({});
    expect(ctx.now).toBe(NOW);
    expect(ctx.task.id).toBe("echo");
  });

  test("surfaces transient run params", () => {
    const { store } = makeStore();
    const ctx = build({
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
    const ctx = build({
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
    const ctx = build({ task: makeTask([]), now: NOW, store, complete });
    await expect(ctx.complete("hi")).rejects.toBeInstanceOf(CapabilityError);
    expect(calls).toBe(0);
  });

  test("throws CLIError when no resolver is configured", async () => {
    const { store } = makeStore();
    const ctx = build({ task: makeTask(["CLI_INVOKE"]), now: NOW, store });
    await expect(ctx.complete("hi")).rejects.toBeInstanceOf(CLIError);
  });

  test("passes the prompt through and returns the result", async () => {
    const { store } = makeStore();
    let seen = "";
    const complete: CompleteFn = async (prompt) => {
      seen = prompt;
      return makeResult("pong");
    };
    const ctx = build({
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
    const ctx = build({
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
    const ctx = build({
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
    const ctx = build({
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
// complete — context-window usage capture (best-effort, non-destructive)
// ---------------------------------------------------------------------------

describe("buildPipelineContext.complete — context usage capture", () => {
  test("records the run's context fill and publishes a usage RUN_EVENT", async () => {
    const { store, contexts, events } = makeStore();
    const bus = new EventBus();
    const published: unknown[] = [];
    bus.on(RUN_EVENT, (p) => published.push(p));
    const complete: CompleteFn = async () => ({
      ...makeResult("pong"),
      usage: {
        inputTokens: 100,
        outputTokens: 20,
        cacheReadTokens: 5_000,
        cacheCreationTokens: 40_000,
        model: "claude-opus-4-8[1m]",
      },
    });
    const ctx = buildPipelineContext({
      task: makeTask(["CLI_INVOKE"]),
      now: NOW,
      runId: RUN_ID,
      parentRunId: "parent-7",
      store,
      events: bus,
      complete,
    });

    const result = await ctx.complete("ping");

    // The completion is returned unchanged.
    expect(result.text).toBe("pong");
    // used = input + cacheRead + cacheCreation (the prompt that was sent); output excluded.
    expect(contexts).toEqual([
      { runId: RUN_ID, usedTokens: 45_100, limit: 1_000_000, model: "claude-opus-4-8[1m]" },
    ]);
    // A persisted 'usage' run_event carries the same numbers for live + reconnect.
    const usageEvent = events.find((e) => e.kind === "usage");
    expect(usageEvent?.payload).toEqual({
      usedTokens: 45_100,
      limit: 1_000_000,
      model: "claude-opus-4-8[1m]",
    });
    // The bus also carries the slice-C io prompt/result frames; assert the usage one.
    const usageFrames = published.filter((p) => (p as { kind?: string }).kind === "usage");
    expect(usageFrames).toHaveLength(1);
    expect(usageFrames[0]).toMatchObject({
      runId: RUN_ID,
      parentRunId: "parent-7",
      kind: "usage",
      data: { usedTokens: 45_100, limit: 1_000_000, model: "claude-opus-4-8[1m]" },
    });
  });

  test("defaults to the 200k window when the model has no 1m hint", async () => {
    const { store, contexts } = makeStore();
    const complete: CompleteFn = async () => ({
      ...makeResult("ok"),
      usage: { inputTokens: 1_000, outputTokens: 10, model: "claude-sonnet-4-6" },
    });
    const ctx = build({ task: makeTask(["CLI_INVOKE"]), now: NOW, store, complete });
    await ctx.complete("p");
    expect(contexts[0]).toEqual({
      runId: RUN_ID,
      usedTokens: 1_000,
      limit: 200_000,
      model: "claude-sonnet-4-6",
    });
  });

  test("prefers the CLI's exact contextWindow over the model-name heuristic", async () => {
    const { store, contexts } = makeStore();
    const complete: CompleteFn = async () => ({
      ...makeResult("ok"),
      // The model has no "1m" tag (the heuristic would say 200k), but the CLI
      // reports the real 1M window — the exact value must win.
      usage: {
        inputTokens: 2_000,
        outputTokens: 5,
        model: "some-future-model",
        contextWindow: 1_000_000,
      },
    });
    const ctx = build({ task: makeTask(["CLI_INVOKE"]), now: NOW, store, complete });
    await ctx.complete("p");
    expect(contexts[0]).toEqual({
      runId: RUN_ID,
      usedTokens: 2_000,
      limit: 1_000_000,
      model: "some-future-model",
    });
  });

  test("records nothing when the completion reports no usage", async () => {
    const { store, contexts, events } = makeStore();
    const ctx = build({
      task: makeTask(["CLI_INVOKE"]),
      now: NOW,
      store,
      complete: async () => makeResult("no-usage"),
    });
    await ctx.complete("p");
    expect(contexts).toHaveLength(0);
    expect(events.find((e) => e.kind === "usage")).toBeUndefined();
  });

  test("a context-capture failure never breaks the completion (best-effort)", async () => {
    const { store } = makeStore();
    const throwingStore: Store = {
      ...store,
      recordRunContext() {
        throw new Error("storage boom");
      },
    };
    const complete: CompleteFn = async () => ({
      ...makeResult("survived"),
      usage: { inputTokens: 10, outputTokens: 1, model: null },
    });
    const ctx = build({
      task: makeTask(["CLI_INVOKE"]),
      now: NOW,
      store: throwingStore,
      complete,
    });
    const result = await ctx.complete("p");
    expect(result.text).toBe("survived");
  });
});

describe("contextWindowFor", () => {
  test("a 1m model tag selects the 1,000,000-token window", () => {
    expect(contextWindowFor("claude-opus-4-8[1m]")).toBe(1_000_000);
    expect(contextWindowFor("Opus 4.8 (1M)")).toBe(1_000_000);
  });
  test("everything else (including null) defaults to 200,000", () => {
    expect(contextWindowFor("claude-sonnet-4-6")).toBe(200_000);
    expect(contextWindowFor(null)).toBe(200_000);
  });
});

// ---------------------------------------------------------------------------
// recordRun — capability gate + persistence
// ---------------------------------------------------------------------------

describe("buildPipelineContext.recordRun", () => {
  test("throws CapabilityError when WRITE_STORAGE is not declared", () => {
    const { store, finished } = makeStore();
    const ctx = build({ task: makeTask(["CLI_INVOKE"]), now: NOW, store });
    expect(() => ctx.recordRun({ status: "ok", summary: "s" })).toThrow(CapabilityError);
    expect(finished).toHaveLength(0);
  });

  test("finishes the up-front run row and returns its id", () => {
    const { store, finished } = makeStore();
    const ctx = build({
      task: makeTask(["WRITE_STORAGE"]),
      now: NOW,
      store,
    });
    const id = ctx.recordRun({ status: "ok", summary: "done" });
    // The returned id is the scheduler-allocated up-front runId.
    expect(id).toBe(RUN_ID);
    expect(finished).toEqual([{ runId: RUN_ID, status: "ok", summary: "done" }]);
  });

  test("redacts the summary to size-only metadata when redactSummaries is set", () => {
    const { store, finished } = makeStore();
    const ctx = build({
      task: makeTask(["WRITE_STORAGE"]),
      now: NOW,
      store,
      redactSummaries: true,
    });
    ctx.recordRun({ status: "ok", summary: "sensitive raw output" });
    // Status kept verbatim; only the free-text summary is redacted.
    expect(finished[0]?.status).toBe("ok");
    expect(finished[0]?.summary).toBe("[redacted: 20 chars]");
    expect(finished[0]?.summary).not.toContain("sensitive");
  });
});

// ---------------------------------------------------------------------------
// emitProgress — capability gate + persist + publish
// ---------------------------------------------------------------------------

describe("buildPipelineContext.emitProgress", () => {
  test("throws CapabilityError when WRITE_STORAGE is not declared", () => {
    const { store, events } = makeStore();
    const ctx = build({ task: makeTask(["CLI_INVOKE"]), now: NOW, store });
    expect(() => ctx.emitProgress({ kind: "step", message: "x" })).toThrow(CapabilityError);
    expect(events).toHaveLength(0);
  });

  test("persists a run_event and publishes a RUN_EVENT carrying runId/parentRunId", () => {
    const { store, events } = makeStore();
    const bus = new EventBus();
    const published: unknown[] = [];
    bus.on(RUN_EVENT, (p) => published.push(p));

    const ctx = buildPipelineContext({
      task: makeTask(["WRITE_STORAGE"]),
      now: NOW,
      runId: RUN_ID,
      parentRunId: "parent-7",
      store,
      events: bus,
    });
    ctx.emitProgress({ kind: "step", message: "doing", data: { pct: 50 } });

    expect(events).toHaveLength(1);
    expect(events[0]?.runId).toBe(RUN_ID);
    expect(events[0]?.kind).toBe("step");
    expect(events[0]?.payload).toEqual({ message: "doing", data: { pct: 50 } });

    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({
      runId: RUN_ID,
      parentRunId: "parent-7",
      kind: "step",
      message: "doing",
      data: { pct: 50 },
    });
  });

  test("omits the data key when no data is supplied", () => {
    const { store, events } = makeStore();
    const ctx = build({ task: makeTask(["WRITE_STORAGE"]), now: NOW, store });
    ctx.emitProgress({ kind: "log", message: "hi" });
    expect(events[0]?.payload).toEqual({ message: "hi" });
  });
});

// ---------------------------------------------------------------------------
// spawn — capability gate + injection
// ---------------------------------------------------------------------------

describe("buildPipelineContext.spawn", () => {
  test("throws CapabilityError when SPAWN_SUBAGENT is not declared", () => {
    const { store } = makeStore();
    const ctx = build({ task: makeTask(["WRITE_STORAGE"]), now: NOW, store });
    expect(() => ctx.spawn({ handlerId: "child", label: "x" })).toThrow(CapabilityError);
  });

  test("throws spawn_unavailable when no spawn fn is injected", () => {
    const { store } = makeStore();
    const ctx = build({ task: makeTask(["SPAWN_SUBAGENT"]), now: NOW, store });
    expect(() => ctx.spawn({ handlerId: "child", label: "x" })).toThrow(/spawn_unavailable|spawn/);
  });

  test("delegates to the injected spawn fn passing the parent context", () => {
    const { store } = makeStore();
    let seenParent: PipelineContext | undefined;
    const handle: SubAgentHandle = {
      runId: "child-1",
      handlerId: "child",
      label: "x",
      done: Promise.resolve({
        taskId: "child",
        runId: "child-1",
        status: "ok",
        summary: "",
        cli: null,
        durationMs: 0,
      }),
    };
    const ctx = build({
      task: makeTask(["SPAWN_SUBAGENT"]),
      now: NOW,
      store,
      spawn: (_descriptor, parent) => {
        seenParent = parent;
        return handle;
      },
    });
    const result = ctx.spawn({ handlerId: "child", label: "x" });
    expect(result).toBe(handle);
    expect(seenParent).toBe(ctx);
  });
});

// ---------------------------------------------------------------------------
// readSignals — capability gate + frozen snapshot
// ---------------------------------------------------------------------------

describe("buildPipelineContext.readSignals", () => {
  test("throws CapabilityError when READ_STORAGE is not declared", () => {
    const { store } = makeStore();
    const ctx = build({ task: makeTask(["WRITE_STORAGE"]), now: NOW, store });
    expect(() => ctx.readSignals()).toThrow(CapabilityError);
  });

  test("returns a frozen snapshot windowed to the look-back when READ_STORAGE is declared", () => {
    const nowMs = NOW.getTime();
    const recentRun = {
      id: "r1",
      ts: nowMs - 1_000,
      pipeline: "p",
      status: "error",
      summary: "",
      parentRunId: null,
      statusUpdatedAt: nowMs - 1_000,
    };
    const oldRun = { ...recentRun, id: "r0", ts: nowMs - 1_000 * 60 * 60 * 48 };
    const { store } = makeStore();
    // Override listRuns to return one in-window and one out-of-window row.
    const storeWithRuns: Store = { ...store, listRuns: () => [oldRun, recentRun] };
    const ctx = build({ task: makeTask(["READ_STORAGE"]), now: NOW, store: storeWithRuns });

    const signals = ctx.readSignals();
    expect(Object.isFrozen(signals)).toBe(true);
    expect(signals.runs).toHaveLength(1);
    expect(signals.runs[0]?.id).toBe("r1");
    expect(signals.rollups[0]).toEqual({ pipeline: "p", total: 1, errors: 1 });
  });
});

describe("buildPipelineContext.notify", () => {
  test("throws CapabilityError when NETWORK_FETCH is not declared", async () => {
    const { store } = makeStore();
    const ctx = build({
      task: makeTask(["WRITE_STORAGE"]),
      now: NOW,
      store,
      notify: async () => ({ delivered: true }),
    });
    await expect(ctx.notify("hi")).rejects.toBeInstanceOf(CapabilityError);
  });

  test("does not invoke the resolver when the capability is denied", async () => {
    const { store } = makeStore();
    let calls = 0;
    const notify: NotifyFn = async () => {
      calls++;
      return { delivered: true };
    };
    const ctx = build({ task: makeTask([]), now: NOW, store, notify });
    await expect(ctx.notify("hi")).rejects.toBeInstanceOf(CapabilityError);
    expect(calls).toBe(0);
  });

  test("returns unavailable (never throws) when no resolver is configured", async () => {
    const { store } = makeStore();
    const ctx = build({ task: makeTask(["NETWORK_FETCH"]), now: NOW, store });
    expect(await ctx.notify("hi")).toEqual({ delivered: false, reason: "unavailable" });
  });

  test("delegates to the resolver and returns its outcome", async () => {
    const { store } = makeStore();
    let seen: NotifyIntent | undefined;
    const notify: NotifyFn = async (intent) => {
      seen = intent;
      return { delivered: true, channel: "telegram" };
    };
    const ctx = build({ task: makeTask(["NETWORK_FETCH"]), now: NOW, store, notify });
    const outcome = await ctx.notify("done", { channel: "telegram", chatId: "42" });
    expect(seen).toEqual({ text: "done", channel: "telegram", chatId: "42" });
    expect(outcome).toEqual({ delivered: true, channel: "telegram" });
  });

  test("omits channel/chatId from the intent when not supplied", async () => {
    const { store } = makeStore();
    let seen: NotifyIntent | undefined;
    const notify: NotifyFn = async (intent) => {
      seen = intent;
      return { delivered: false, reason: "no_channel" };
    };
    const ctx = build({ task: makeTask(["NETWORK_FETCH"]), now: NOW, store, notify });
    const outcome = await ctx.notify("ping");
    expect(seen).toEqual({ text: "ping" });
    expect(Object.hasOwn(seen ?? {}, "channel")).toBe(false);
    expect(Object.hasOwn(seen ?? {}, "chatId")).toBe(false);
    expect(outcome.delivered).toBe(false);
  });
});

describe("redactSummary", () => {
  test("replaces content with a size-only marker", () => {
    expect(redactSummary("hello")).toBe("[redacted: 5 chars]");
    expect(redactSummary("")).toBe("[redacted: 0 chars]");
  });
});

// ---------------------------------------------------------------------------
// Completion IO observability (specs/orchestrator-home.md slice C)
// ---------------------------------------------------------------------------

describe("complete IO events", () => {
  function ioEvents(events: AppendRunEventInput[]): AppendRunEventInput[] {
    return events.filter((e) => e.kind === "io");
  }

  function buildIoCtx(opts?: { completeImpl?: CompleteFn; redactSummaries?: boolean }): {
    ctx: PipelineContext;
    events: AppendRunEventInput[];
    clis: { runId: string; cli: string }[];
    bus: EventBus;
    published: unknown[];
  } {
    const { store, events, clis } = makeStore();
    const bus = new EventBus();
    const published: unknown[] = [];
    bus.on(RUN_EVENT, (payload) => published.push(payload));
    const completeImpl: CompleteFn =
      opts?.completeImpl ??
      (async () => ({ ...makeResult("the reply"), cli: "claude", model: "opus" }));
    const ctx = buildPipelineContext({
      task: makeTask(["CLI_INVOKE", "WRITE_STORAGE"]),
      now: new Date(),
      runId: RUN_ID,
      parentRunId: null,
      store,
      complete: completeImpl,
      events: bus,
      ...(opts?.redactSummaries === true ? { redactSummaries: true } : {}),
    });
    return { ctx, events, clis, bus, published };
  }

  test("a successful completion persists exactly one prompt and one result io event", async () => {
    const { ctx, events, clis, published } = buildIoCtx();
    await ctx.complete("what is up?");

    const io = ioEvents(events);
    expect(io).toHaveLength(2);
    const promptPayload = io[0]?.payload as { message: string; data: Record<string, unknown> };
    expect(promptPayload.message).toBe("prompt");
    expect(promptPayload.data.text).toBe("what is up?");
    expect(promptPayload.data.truncated).toBe(false);

    const resultPayload = io[1]?.payload as { message: string; data: Record<string, unknown> };
    expect(resultPayload.message).toBe("result");
    expect(resultPayload.data.text).toBe("the reply");
    expect(resultPayload.data.cli).toBe("claude");
    expect(resultPayload.data.model).toBe("opus");
    expect(resultPayload.data.exitCode).toBe(0);

    // The serving CLI is recorded as the run badge fallback.
    expect(clis).toEqual([{ runId: RUN_ID, cli: "claude" }]);
    // Both events were also published on the bus.
    expect(published.filter((p) => (p as { kind?: string }).kind === "io")).toHaveLength(2);
  });

  test("bodies are capped at 16KB with a truncated flag", async () => {
    const { ctx, events } = buildIoCtx();
    await ctx.complete("x".repeat(20_000));

    const promptPayload = ioEvents(events)[0]?.payload as { data: Record<string, unknown> };
    expect(promptPayload.data.truncated).toBe(true);
    expect((promptPayload.data.text as string).length).toBe(16_384);
  });

  test("redactSummaries redacts io bodies the same way as run summaries", async () => {
    const { ctx, events } = buildIoCtx({ redactSummaries: true });
    await ctx.complete("secret prompt");

    const promptPayload = ioEvents(events)[0]?.payload as { data: Record<string, unknown> };
    expect(promptPayload.data.text).toBe(redactSummary("secret prompt"));
    const resultPayload = ioEvents(events)[1]?.payload as { data: Record<string, unknown> };
    expect(resultPayload.data.text).toBe(redactSummary("the reply"));
  });

  test("a failing completion emits an io error event and rethrows", async () => {
    const { ctx, events } = buildIoCtx({
      completeImpl: async () => {
        throw new CLIError("timeout", "claude: timed out after 30000ms");
      },
    });

    await expect(ctx.complete("hi")).rejects.toThrow(/timed out/);
    const io = ioEvents(events);
    expect(io).toHaveLength(2); // prompt + error
    const errorPayload = io[1]?.payload as { message: string; data: Record<string, unknown> };
    expect(errorPayload.message).toBe("error");
    expect(errorPayload.data.text).toContain("timed out");
  });

  test("a throwing store never breaks the completion (best-effort)", async () => {
    const { store } = makeStore();
    const broken: Store = {
      ...store,
      appendRunEvent() {
        throw new Error("disk full");
      },
      recordRunCli() {
        throw new Error("disk full");
      },
    };
    const ctx = buildPipelineContext({
      task: makeTask(["CLI_INVOKE", "WRITE_STORAGE"]),
      now: new Date(),
      runId: RUN_ID,
      parentRunId: null,
      store: broken,
      complete: async () => ({ ...makeResult("ok"), cli: "claude" }),
    });

    const result = await ctx.complete("hi");
    expect(result.text).toBe("ok");
  });
});
