import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  CompleteResult,
  PipelineContext,
  RunOutcome,
  SubAgentDescriptor,
  SubAgentHandle,
} from "@vesper/core";
import { HandlerRegistry, openStore, Scheduler, type Store } from "@vesper/core";
import { grantedCapabilities, registerPipelines } from "../index.ts";
import {
  makeRouterHandler,
  ROUTE_ALLOWLIST,
  ROUTER_HANDLER_ID,
  routerTaskInput,
} from "./handler.ts";

// ---------------------------------------------------------------------------
// Fake PipelineContext — records complete prompts, spawn descriptors, and runs.
// ---------------------------------------------------------------------------

interface FakeContext {
  readonly ctx: PipelineContext;
  readonly completePrompts: string[];
  readonly spawned: SubAgentDescriptor[];
  readonly recordedRuns: Array<{ status: string; summary: string }>;
  readonly progress: string[];
}

function makeFakeContext(options: {
  readonly params?: Record<string, unknown>;
  /** Text the fake `complete` returns (the classifier label). */
  readonly classifyReply?: string;
  /** Status the spawned child resolves with. */
  readonly childStatus?: string;
  /** Summary the spawned child resolves with (the child pipeline's actual answer). */
  readonly childSummary?: string;
  /** When true, the spawned child's `done` rejects (handler must tolerate it). */
  readonly childRejects?: boolean;
}): FakeContext {
  const completePrompts: string[] = [];
  const spawned: SubAgentDescriptor[] = [];
  const recordedRuns: Array<{ status: string; summary: string }> = [];
  const progress: string[] = [];

  const ctx: PipelineContext = {
    task: {
      id: "router",
      kind: "manual",
      schedule_expr: "",
      handler_id: "router",
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
      required_capabilities: ["CLI_INVOKE", "WRITE_STORAGE", "SPAWN_SUBAGENT"],
    },
    now: new Date(2025, 0, 1),
    params: options.params ?? {},
    runId: "router-run",
    parentRunId: null,
    async complete(prompt): Promise<CompleteResult> {
      completePrompts.push(prompt);
      const text = options.classifyReply ?? "none";
      return { text, exit_code: 0, raw_stdout: text, raw_stderr: "", duration_ms: 1 };
    },
    recordRun({ status, summary }) {
      recordedRuns.push({ status, summary });
      return "router-run";
    },
    emitProgress(e) {
      progress.push(e.message);
    },
    spawn(descriptor): SubAgentHandle {
      spawned.push(descriptor);
      const outcome: RunOutcome = {
        taskId: descriptor.handlerId,
        runId: "child-run",
        status: options.childStatus ?? "ok",
        summary: options.childSummary ?? "child done",
        cli: null,
        durationMs: 1,
      };
      return {
        runId: "child-run",
        handlerId: descriptor.handlerId,
        label: descriptor.label,
        done: options.childRejects
          ? Promise.reject(new Error("child failed"))
          : Promise.resolve(outcome),
      };
    },
    readSignals() {
      throw new Error("readSignals is not supported in this fake context");
    },
    async notify() {
      return { delivered: false };
    },
  };

  return { ctx, completePrompts, spawned, recordedRuns, progress };
}

// ---------------------------------------------------------------------------
// routerHandler — classify + dispatch + no-eval fallback
// ---------------------------------------------------------------------------

describe("routerHandler", () => {
  test("an empty message produces a clarify turn with no spawn and no CLI call", async () => {
    const fake = makeFakeContext({ params: { message: "   " } });
    await makeRouterHandler()(fake.ctx);

    expect(fake.completePrompts).toHaveLength(0);
    expect(fake.spawned).toHaveLength(0);
    expect(fake.recordedRuns).toHaveLength(1);
    expect(fake.recordedRuns[0]?.status).toBe("clarify");
  });

  test("a mapped label spawns the allowlisted handler id with the message", async () => {
    const fake = makeFakeContext({
      params: { message: "run the self test" },
      classifyReply: "selftest",
      childSummary: "Hello from the self-test — I am Claude Code.",
    });
    await makeRouterHandler()(fake.ctx);

    expect(fake.completePrompts).toHaveLength(1);
    expect(fake.spawned).toHaveLength(1);
    expect(fake.spawned[0]?.handlerId).toBe(ROUTE_ALLOWLIST.selftest);
    expect(fake.spawned[0]?.params?.message).toBe("run the self test");
    // The child is granted exactly the capabilities ITS task declares — selftest
    // needs CLI_INVOKE to reach the adapter, so a WRITE_STORAGE-only grant would
    // deny the run at the context boundary (the original chatbot-home bug).
    expect(fake.spawned[0]?.capabilities).toEqual(["CLI_INVOKE", "WRITE_STORAGE"]);
    expect(fake.recordedRuns[0]?.status).toBe("ok");
    // The assistant reply surfaces the child pipeline's ACTUAL answer, not a routing
    // receipt — `POST /api/chat` renders this summary as the assistant turn's text.
    expect(fake.recordedRuns[0]?.summary).toBe("Hello from the self-test — I am Claude Code.");
  });

  test("the orchestrate route grants the child SPAWN_SUBAGENT so it can fan out", async () => {
    const fake = makeFakeContext({
      params: { message: "plan, draft, and review something" },
      classifyReply: "orchestrate",
    });
    await makeRouterHandler()(fake.ctx);

    expect(fake.spawned).toHaveLength(1);
    expect(fake.spawned[0]?.handlerId).toBe(ROUTE_ALLOWLIST.orchestrate);
    // orchestrator-demo spawns its own sub-agents; without SPAWN_SUBAGENT the child
    // is denied at its first spawn ("capabilities denied: SPAWN_SUBAGENT").
    expect(fake.spawned[0]?.capabilities).toEqual(["SPAWN_SUBAGENT", "WRITE_STORAGE"]);
  });

  test("merges the target template default_params UNDER the user message (#4)", async () => {
    const fake = makeFakeContext({
      params: { message: "run the self test" },
      classifyReply: "selftest",
    });
    await makeRouterHandler({
      // The injected reader supplies the target handler's editable default_params;
      // a template-provided `message` must NOT override the real user message.
      getDefaultParams: (handlerId) =>
        handlerId === ROUTE_ALLOWLIST.selftest ? { tone: "concise", message: "IGNORED" } : {},
    })(fake.ctx);

    expect(fake.spawned).toHaveLength(1);
    expect(fake.spawned[0]?.params?.tone).toBe("concise");
    expect(fake.spawned[0]?.params?.message).toBe("run the self test");
  });

  test("the classifier reply is normalised (case/whitespace/punctuation tolerated)", async () => {
    const fake = makeFakeContext({ params: { message: "x" }, classifyReply: "  SELFTEST.\n" });
    await makeRouterHandler()(fake.ctx);
    expect(fake.spawned[0]?.handlerId).toBe(ROUTE_ALLOWLIST.selftest);
  });

  test("an unmapped label produces a clarify turn and NEVER spawns (no-eval invariant)", async () => {
    const fake = makeFakeContext({ params: { message: "do my taxes" }, classifyReply: "taxes" });
    await makeRouterHandler()(fake.ctx);

    expect(fake.spawned).toHaveLength(0);
    expect(fake.recordedRuns[0]?.status).toBe("clarify");
  });

  test("a free-form handler-id reply is refused (cannot inject an arbitrary id)", async () => {
    // The model returns a string that looks like a real handler id but is NOT a label key.
    const fake = makeFakeContext({
      params: { message: "x" },
      classifyReply: "rm -rf; orchestrator-demo",
    });
    await makeRouterHandler()(fake.ctx);
    expect(fake.spawned).toHaveLength(0);
    expect(fake.recordedRuns[0]?.status).toBe("clarify");
  });

  test('the literal "none" reply maps to a clarify turn', async () => {
    const fake = makeFakeContext({ params: { message: "x" }, classifyReply: "none" });
    await makeRouterHandler()(fake.ctx);
    expect(fake.spawned).toHaveLength(0);
    expect(fake.recordedRuns[0]?.status).toBe("clarify");
  });

  test("a child failure is tolerated — the router records 'partial' with a fallback reply", async () => {
    const fake = makeFakeContext({
      params: { message: "x" },
      classifyReply: "selftest",
      childRejects: true,
    });
    await makeRouterHandler()(fake.ctx);
    expect(fake.spawned).toHaveLength(1);
    expect(fake.recordedRuns[0]?.status).toBe("partial");
    // The child threw (no outcome) — the reply is a plain-language fallback that still
    // names the pipeline so the user is not left with a silent/empty assistant turn.
    expect(fake.recordedRuns[0]?.summary).toContain("returned no response");
  });

  test("an empty child summary falls back rather than surfacing a blank reply", async () => {
    const fake = makeFakeContext({
      params: { message: "x" },
      classifyReply: "selftest",
      childSummary: "   ",
    });
    await makeRouterHandler()(fake.ctx);
    expect(fake.recordedRuns[0]?.summary).toContain("returned no response");
  });

  test("a custom allowlist drives dispatch (handler is configurable)", async () => {
    const fake = makeFakeContext({ params: { message: "x" }, classifyReply: "greet" });
    await makeRouterHandler({ allowlist: { greet: "selftest" } })(fake.ctx);
    expect(fake.spawned[0]?.handlerId).toBe("selftest");
  });

  test("the classify prompt enumerates the allowlist labels and fences the message", async () => {
    const fake = makeFakeContext({ params: { message: "SECRET" }, classifyReply: "none" });
    await makeRouterHandler()(fake.ctx);
    const prompt = fake.completePrompts[0] ?? "";
    expect(prompt).toContain("selftest");
    expect(prompt).toContain("orchestrate");
    expect(prompt).toContain("SECRET");
  });
});

// ---------------------------------------------------------------------------
// Registration — the router is installed with the right capabilities.
// ---------------------------------------------------------------------------

describe("router registration", () => {
  let path: string;
  let db: Database;
  let store: Store;

  function setup(): { registry: HandlerRegistry; scheduler: Scheduler } {
    path = join(tmpdir(), `vesper-router-${crypto.randomUUID()}.db`);
    openStore(path).close();
    db = new Database(path);
    store = openStore(path);
    const registry = new HandlerRegistry();
    const scheduler = new Scheduler({ db, registry, grants: grantedCapabilities() });
    registerPipelines(scheduler, registry);
    return { registry, scheduler };
  }

  function teardown(): void {
    db.close();
    store.close();
    try {
      rmSync(path, { force: true });
      rmSync(`${path}-shm`, { force: true });
      rmSync(`${path}-wal`, { force: true });
    } catch {
      // ignore
    }
  }

  test("registers a manual router task requiring CLI_INVOKE + WRITE_STORAGE + SPAWN_SUBAGENT", () => {
    const { scheduler } = setup();
    try {
      const task = scheduler.list().find((t) => t.id === "router");
      expect(task).toBeDefined();
      expect(task?.kind).toBe("manual");
      expect(task?.required_capabilities).toContain("CLI_INVOKE");
      expect(task?.required_capabilities).toContain("WRITE_STORAGE");
      expect(task?.required_capabilities).toContain("SPAWN_SUBAGENT");
    } finally {
      teardown();
    }
  });

  test("the router's spawn targets are all registered handlers (allowlist is resolvable)", () => {
    const { registry } = setup();
    try {
      for (const handlerId of Object.values(ROUTE_ALLOWLIST)) {
        expect(registry.has(handlerId)).toBe(true);
      }
      expect(registry.has(ROUTER_HANDLER_ID)).toBe(true);
    } finally {
      teardown();
    }
  });

  test("the host grant union covers the router task input capabilities", () => {
    const granted = grantedCapabilities();
    for (const cap of routerTaskInput.required_capabilities ?? []) {
      expect(granted).toContain(cap);
    }
  });
});

// ---------------------------------------------------------------------------
// The `answer` action (specs/orchestrator-home.md slice E)
// ---------------------------------------------------------------------------

describe("router answer action", () => {
  function makeAnswerCtx(replyText: string): {
    ctx: PipelineContext;
    prompts: string[];
    recorded: { status: string; summary: string }[];
    textEvents: { message: string; data?: Record<string, unknown> }[];
    spawned: number;
  } {
    const prompts: string[] = [];
    const recorded: { status: string; summary: string }[] = [];
    const textEvents: { message: string; data?: Record<string, unknown> }[] = [];
    const state = { spawned: 0 };
    const ctx = {
      task: {
        id: "router",
        kind: "manual",
        schedule_expr: "",
        handler_id: "router",
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
        required_capabilities: ["CLI_INVOKE", "WRITE_STORAGE", "SPAWN_SUBAGENT"],
      },
      now: new Date(2026, 0, 1),
      params: {
        message: "what pipelines are available?",
        sessionId: "11111111-2222-4333-8444-555555555555",
      },
      runId: "router-run",
      parentRunId: null,
      async complete(
        prompt: string,
        opts?: { onText?: (d: string) => void },
      ): Promise<CompleteResult> {
        prompts.push(prompt);
        // First call = classify -> "answer"; second = the grounded answer, streamed.
        if (prompts.length === 1) {
          return {
            text: "answer",
            exit_code: 0,
            raw_stdout: "answer",
            raw_stderr: "",
            duration_ms: 1,
          };
        }
        for (const piece of replyText.match(/.{1,6}/g) ?? []) opts?.onText?.(piece);
        return {
          text: replyText,
          exit_code: 0,
          raw_stdout: replyText,
          raw_stderr: "",
          duration_ms: 1,
        };
      },
      recordRun({ status, summary }: { status: string; summary: string }) {
        recorded.push({ status, summary });
        return "router-run";
      },
      emitProgress(e: { kind: string; message: string; data?: Record<string, unknown> }) {
        if (e.kind === "text")
          textEvents.push({ message: e.message, ...(e.data ? { data: e.data } : {}) });
      },
      spawn() {
        state.spawned += 1;
        throw new Error("answer must not spawn");
      },
    } as unknown as PipelineContext;
    return { ctx, prompts, recorded, textEvents, spawned: state.spawned };
  }

  test("answers from the runtime snapshot, streams deltas, never spawns", async () => {
    const reply = "I can run selftest, loop, and software-engineer.";
    const { ctx, prompts, recorded, textEvents } = makeAnswerCtx(reply);
    const handler = makeRouterHandler({
      getRuntimeContext: () => ({
        pipelines: [
          { id: "selftest", summary: "runtime self-test" },
          { id: "loop", summary: "autonomous reasoning loop" },
        ],
        recentRuns: [{ pipeline: "loop", status: "succeeded", summary: "done", ts: 1 }],
        schedules: [
          { id: "benchmark-ingest", kind: "cron", schedule_expr: "15 6 * * *", enabled: true },
        ],
      }),
    });

    await handler(ctx);

    // The answer prompt is grounded: it names the registered pipelines.
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("selftest: runtime self-test");
    expect(prompts[1]).toContain("benchmark-ingest");
    expect(prompts[1]).toContain("what pipelines are available?");

    // Streamed deltas reassemble to the full reply and carry the session id.
    expect(textEvents.length).toBeGreaterThanOrEqual(1);
    expect(textEvents.map((e) => e.message).join("")).toBe(reply);
    expect(textEvents[0]?.data?.sessionId).toBe("11111111-2222-4333-8444-555555555555");

    // The durable turn is the full answer; nothing was dispatched.
    expect(recorded).toEqual([{ status: "ok", summary: reply }]);
  });

  test("an empty snapshot still answers (no provider wired)", async () => {
    const { ctx, recorded } = makeAnswerCtx("Nothing has run yet.");
    const handler = makeRouterHandler({});
    await handler(ctx);
    expect(recorded[0]?.status).toBe("ok");
  });
});

// ---------------------------------------------------------------------------
// Orchestration plans (specs/orchestrator-home.md slice F)
// ---------------------------------------------------------------------------

describe("router plan execution", () => {
  /** Stateful ctx: complete replies come from a queue; spawn resolves per handler. */
  function makePlanCtx(replies: string[]): {
    ctx: PipelineContext;
    prompts: string[];
    spawned: SubAgentDescriptor[];
    recorded: { status: string; summary: string }[];
  } {
    const prompts: string[] = [];
    const spawned: SubAgentDescriptor[] = [];
    const recorded: { status: string; summary: string }[] = [];
    const ctx = {
      task: {
        id: "router",
        kind: "manual",
        schedule_expr: "",
        handler_id: "router",
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
        required_capabilities: ["CLI_INVOKE", "WRITE_STORAGE", "SPAWN_SUBAGENT"],
      },
      now: new Date(2026, 0, 1),
      params: { message: "use loop and selftest to do a thing" },
      runId: "router-run",
      parentRunId: null,
      async complete(prompt: string): Promise<CompleteResult> {
        prompts.push(prompt);
        const text = replies.shift() ?? "none";
        return { text, exit_code: 0, raw_stdout: text, raw_stderr: "", duration_ms: 1 };
      },
      recordRun({ status, summary }: { status: string; summary: string }) {
        recorded.push({ status, summary });
        return "router-run";
      },
      emitProgress() {},
      spawn(descriptor: SubAgentDescriptor): SubAgentHandle {
        spawned.push(descriptor);
        const outcome: RunOutcome = {
          taskId: descriptor.handlerId,
          runId: `child-${spawned.length}`,
          status: "ok",
          summary: `${descriptor.label} done`,
          cli: null,
          durationMs: 1,
        };
        return {
          runId: `child-${spawned.length}`,
          handlerId: descriptor.handlerId,
          label: descriptor.label,
          done: Promise.resolve(outcome),
        };
      },
    } as unknown as PipelineContext;
    return { ctx, prompts, spawned, recorded };
  }

  const planReply = (plan: unknown) => `\`\`\`json\n${JSON.stringify(plan)}\n\`\`\``;

  test("executes a two-step plan sequentially with result piping and model picks", async () => {
    const replies = [
      "run", // classify
      planReply({
        steps: [
          {
            tasks: [{ pipeline: "loop", label: "research", prompt: "goal A", difficulty: "hard" }],
          },
          {
            tasks: [
              {
                pipeline: "selftest",
                label: "summarize",
                prompt: "old prompt",
                difficulty: "easy",
              },
            ],
          },
        ],
        notes: "n",
      }),
      '```json\n[{"label":"summarize","prompt":"summarize what research found"}]\n```', // revision
    ];
    const { ctx, prompts, spawned, recorded } = makePlanCtx(replies);
    const picks: string[] = [];
    const handler = makeRouterHandler({
      pickModel: (difficulty) => {
        picks.push(difficulty);
        return difficulty === "hard" ? "claude-opus" : "claude-haiku";
      },
    });

    await handler(ctx);

    // Both tasks ran, in step order, with the authored prompts in the right params.
    expect(spawned).toHaveLength(2);
    expect(spawned[0]?.handlerId).toBe("loop");
    expect(spawned[0]?.params?.goal).toBe("goal A");
    expect(spawned[0]?.model).toBe("claude-opus"); // hard -> frontier pick
    expect(spawned[1]?.handlerId).toBe("selftest");
    // Result piping: the second step's prompt was re-authored from step-1 results.
    expect(spawned[1]?.params?.prompt).toBe("summarize what research found");
    expect(spawned[1]?.model).toBe("claude-haiku");
    // The revision prompt carried step-1's outcome.
    expect(prompts[2]).toContain("research");
    expect(recorded[0]?.status).toBe("ok");
    expect(recorded[0]?.summary).toContain("research");
    expect(picks).toEqual(["hard", "easy"]);
  });

  test("an unplannable wish records a clarify turn (no spawns)", async () => {
    const { ctx, spawned, recorded } = makePlanCtx(["run", "I refuse to emit JSON"]);
    const handler = makeRouterHandler({});
    await handler(ctx);
    expect(spawned).toHaveLength(0);
    expect(recorded[0]?.status).toBe("clarify");
  });

  test("spawnsOwnChildren tasks go through the sibling runner with display lineage", async () => {
    const replies = [
      "run",
      planReply({
        steps: [
          {
            tasks: [
              {
                pipeline: "software-engineer",
                label: "code it",
                prompt: "the wish",
                params: { repo: "/tmp/r" },
              },
            ],
          },
        ],
      }),
    ];
    const { ctx, spawned, recorded } = makePlanCtx(replies);
    const siblingCalls: {
      handlerId: string;
      parentRunId: string;
      params: Record<string, unknown>;
    }[] = [];
    const handler = makeRouterHandler({
      runSibling: async (handlerId, options) => {
        siblingCalls.push({
          handlerId,
          parentRunId: options.parentRunId,
          params: { ...options.params },
        });
        return { runId: "sib-1", status: "ok", summary: "staged" };
      },
    });

    await handler(ctx);

    expect(spawned).toHaveLength(0); // never ctx.spawn for a spawnsOwnChildren task
    expect(siblingCalls[0]?.handlerId).toBe("software-engineer");
    expect(siblingCalls[0]?.parentRunId).toBe("router-run");
    expect(siblingCalls[0]?.params.wish).toBe("the wish");
    expect(siblingCalls[0]?.params.repo).toBe("/tmp/r");
    expect(recorded[0]?.status).toBe("ok");
  });

  test("a spawnsOwnChildren task without a sibling runner fails soft", async () => {
    const replies = [
      "run",
      planReply({
        steps: [
          {
            tasks: [
              { pipeline: "software-engineer", label: "code", prompt: "w", params: { repo: "/r" } },
            ],
          },
        ],
      }),
    ];
    const { ctx, recorded } = makePlanCtx(replies);
    const handler = makeRouterHandler({});
    await handler(ctx);
    expect(recorded[0]?.status).toBe("partial");
    expect(recorded[0]?.summary).toContain("sibling runner");
  });
});
