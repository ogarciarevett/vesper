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
