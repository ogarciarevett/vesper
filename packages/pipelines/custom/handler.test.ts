import { describe, expect, test } from "bun:test";
import type {
  CompleteResult,
  PipelineContext,
  RunOutcome,
  SubAgentDescriptor,
  SubAgentHandle,
} from "@vesper/core";
import { ORCHESTRATION_CONTRACTS } from "../router/contracts.ts";
import { type CustomPipelineDeps, createCustomPipelineHandler, customTaskId } from "./handler.ts";
import { buildOrchestratorRevisionPrompt, parseOrchestratorRevision } from "./orchestrate.ts";

// ---------------------------------------------------------------------------
// Fake PipelineContext — records complete calls, spawns, runs, progress.
// ---------------------------------------------------------------------------

interface CompleteCall {
  readonly prompt: string;
  readonly opts: { cli?: string; model?: string; timeoutMs?: number } | undefined;
}

interface FakeContext {
  readonly ctx: PipelineContext;
  readonly completes: CompleteCall[];
  readonly spawned: SubAgentDescriptor[];
  readonly recordedRuns: Array<{ status: string; summary: string }>;
  readonly progress: string[];
}

function makeFakeContext(options: {
  /** Maps a matched substring of the prompt to the reply text (first match wins). */
  readonly replies?: ReadonlyArray<readonly [string, string]>;
  readonly defaultReply?: string;
  readonly childStatus?: string;
  readonly childSummary?: string;
}): FakeContext {
  const completes: CompleteCall[] = [];
  const spawned: SubAgentDescriptor[] = [];
  const recordedRuns: Array<{ status: string; summary: string }> = [];
  const progress: string[] = [];

  const ctx: PipelineContext = {
    task: {
      id: customTaskId("p"),
      kind: "manual",
      schedule_expr: "",
      handler_id: customTaskId("p"),
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
    params: {},
    runId: "custom-run",
    parentRunId: null,
    async complete(prompt, opts): Promise<CompleteResult> {
      completes.push({ prompt, opts });
      const match = options.replies?.find(([needle]) => prompt.includes(needle));
      const text = match?.[1] ?? options.defaultReply ?? "done";
      return { text, exit_code: 0, raw_stdout: text, raw_stderr: "", duration_ms: 1 };
    },
    recordRun({ status, summary }) {
      recordedRuns.push({ status, summary });
      return "custom-run";
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
        done: Promise.resolve(outcome),
      };
    },
    readSignals() {
      throw new Error("readSignals is not supported in this fake context");
    },
    async notify() {
      return { delivered: false };
    },
  };

  return { ctx, completes, spawned, recordedRuns, progress };
}

function deps(
  doc: Record<string, unknown> | null,
  extra: Partial<CustomPipelineDeps> = {},
): CustomPipelineDeps {
  return {
    getDoc: () => doc,
    contracts: ORCHESTRATION_CONTRACTS,
    ...extra,
  };
}

const promptOnlyDoc: Record<string, unknown> = {
  v: 1,
  name: "Two prompts",
  description: "two parallel prompts",
  orchestrator: { enabled: false },
  stages: [
    {
      tasks: [
        { kind: "prompt", id: "a", title: "A", prompt: "say a", cli: "claude", model: "gpt" },
        { kind: "prompt", id: "b", title: "B", prompt: "say b" },
      ],
    },
  ],
};

describe("createCustomPipelineHandler", () => {
  test("records an error when the doc is missing or invalid", async () => {
    const missing = makeFakeContext({});
    await createCustomPipelineHandler("p", deps(null))(missing.ctx);
    expect(missing.recordedRuns[0]?.status).toBe("error");
    expect(missing.recordedRuns[0]?.summary).toContain("not found");

    const invalid = makeFakeContext({});
    await createCustomPipelineHandler("p", deps({ v: 1 }))(invalid.ctx);
    expect(invalid.recordedRuns[0]?.status).toBe("error");
    expect(invalid.recordedRuns[0]?.summary).toContain("validation");
  });

  test("runs prompt steps with per-step cli/model and records ok", async () => {
    const fake = makeFakeContext({ defaultReply: "answer" });
    await createCustomPipelineHandler("p", deps(promptOnlyDoc))(fake.ctx);

    expect(fake.completes).toHaveLength(2);
    const withRouting = fake.completes.find((c) => c.prompt.includes("say a"));
    expect(withRouting?.opts?.cli).toBe("claude");
    expect(withRouting?.opts?.model).toBe("gpt");
    expect(fake.recordedRuns[0]?.status).toBe("ok");
    expect(fake.recordedRuns[0]?.summary).toContain("A:");
    expect(fake.recordedRuns[0]?.summary).toContain("B:");
  });

  test("pipes stage-1 results into stage-2 placeholders", async () => {
    const doc: Record<string, unknown> = {
      v: 1,
      name: "Piped",
      orchestrator: { enabled: false },
      stages: [
        { tasks: [{ kind: "prompt", id: "draft", title: "Draft", prompt: "write" }] },
        {
          tasks: [
            {
              kind: "prompt",
              id: "polish",
              title: "Polish",
              prompt: "improve: {{stages.1.draft.result}}",
            },
          ],
        },
      ],
    };
    const fake = makeFakeContext({ replies: [["write", "THE DRAFT"]], defaultReply: "ok" });
    await createCustomPipelineHandler("p", deps(doc))(fake.ctx);

    const second = fake.completes[1];
    expect(second?.prompt).toContain("improve: THE DRAFT");
  });

  test("orchestrator re-authors stage-2 prompts when enabled", async () => {
    const doc: Record<string, unknown> = {
      v: 1,
      name: "Orchestrated",
      orchestrator: { enabled: true, model: "claude-opus" },
      stages: [
        { tasks: [{ kind: "prompt", id: "one", title: "One", prompt: "first" }] },
        { tasks: [{ kind: "prompt", id: "two", title: "Two", prompt: "second" }] },
      ],
    };
    const revision = '```json\n[{ "id": "two", "prompt": "REWRITTEN second" }]\n```';
    const fake = makeFakeContext({
      replies: [
        ["re-author the next stage", revision],
        ["Re-author the next stage", revision],
        ["first", "first result"],
      ],
      defaultReply: "done",
    });
    await createCustomPipelineHandler("p", deps(doc))(fake.ctx);

    // first prompt + orchestrator revision + rewritten second prompt
    expect(fake.completes).toHaveLength(3);
    const orchestratorCall = fake.completes[1];
    expect(orchestratorCall?.opts?.model).toBe("claude-opus");
    const second = fake.completes[2];
    expect(second?.prompt).toContain("REWRITTEN second");
  });

  test("pipeline steps spawn the contract target with its capabilities", async () => {
    const doc: Record<string, unknown> = {
      v: 1,
      name: "Spawning",
      orchestrator: { enabled: false },
      stages: [
        {
          tasks: [
            {
              kind: "pipeline",
              id: "l",
              title: "Loop it",
              target: "loop",
              prompt: "the objective",
              params: { maxIterations: "2" },
              model: "gpt",
            },
          ],
        },
      ],
    };
    const fake = makeFakeContext({ childSummary: "loop finished" });
    await createCustomPipelineHandler("p", deps(doc))(fake.ctx);

    expect(fake.spawned).toHaveLength(1);
    const spawned = fake.spawned[0];
    expect(spawned?.handlerId).toBe("loop");
    expect(spawned?.params?.goal).toBe("the objective");
    expect(spawned?.params?.maxIterations).toBe("2");
    expect(spawned?.model).toBe("gpt");
    expect(spawned?.capabilities).toEqual(ORCHESTRATION_CONTRACTS.loop?.capabilities ?? []);
    expect(fake.recordedRuns[0]?.status).toBe("ok");
    expect(fake.recordedRuns[0]?.summary).toContain("loop finished");
  });

  test("spawnsOwnChildren targets use the sibling runner (and fail fast without one)", async () => {
    const doc: Record<string, unknown> = {
      v: 1,
      name: "SWE",
      orchestrator: { enabled: false },
      stages: [
        {
          tasks: [
            {
              kind: "pipeline",
              id: "swe",
              title: "Code it",
              target: "software-engineer",
              prompt: "the wish",
              params: { repo: "/tmp/repo" },
            },
          ],
        },
      ],
    };

    const unwired = makeFakeContext({});
    await createCustomPipelineHandler("p", deps(doc))(unwired.ctx);
    expect(unwired.recordedRuns[0]?.status).toBe("error");
    expect(unwired.recordedRuns[0]?.summary).toContain("sibling");

    const calls: Array<{ handlerId: string; params: Record<string, unknown> }> = [];
    const wired = makeFakeContext({});
    await createCustomPipelineHandler(
      "p",
      deps(doc, {
        runSibling: async (handlerId, options) => {
          calls.push({ handlerId, params: options.params });
          return { runId: "sib", status: "ok", summary: "staged" };
        },
      }),
    )(wired.ctx);
    expect(calls[0]?.handlerId).toBe("software-engineer");
    expect(calls[0]?.params.wish).toBe("the wish");
    expect(calls[0]?.params.repo).toBe("/tmp/repo");
    expect(wired.recordedRuns[0]?.status).toBe("ok");
  });

  test("skills are prepended and missing skills are skipped with a log", async () => {
    const doc: Record<string, unknown> = {
      v: 1,
      name: "Skilled",
      orchestrator: { enabled: false },
      stages: [
        {
          tasks: [
            {
              kind: "prompt",
              id: "s",
              title: "S",
              prompt: "go",
              skills: ["writing", "ghost"],
              command: "/draft",
            },
          ],
        },
      ],
    };
    const fake = makeFakeContext({});
    await createCustomPipelineHandler(
      "p",
      deps(doc, { getSkillBody: async (name) => (name === "writing" ? "WRITE WELL" : null) }),
    )(fake.ctx);

    const prompt = fake.completes[0]?.prompt ?? "";
    expect(prompt).toContain("## Skill: writing");
    expect(prompt).toContain("WRITE WELL");
    expect(prompt).toContain("/draft go");
    expect(prompt).not.toContain("ghost");
    expect(fake.progress.join(" ")).toContain('skill "ghost" not found');
  });

  test("memory hits are injected into stage 1 when sharing.memory is on", async () => {
    const doc: Record<string, unknown> = {
      v: 1,
      name: "Remembering",
      orchestrator: { enabled: false },
      sharing: { mode: "piped", memory: true },
      stages: [{ tasks: [{ kind: "prompt", id: "m", title: "M", prompt: "go" }] }],
    };
    const fake = makeFakeContext({});
    await createCustomPipelineHandler(
      "p",
      deps(doc, { searchMemory: async () => ["a past note"] }),
    )(fake.ctx);

    expect(fake.completes[0]?.prompt).toContain("## Relevant memory");
    expect(fake.completes[0]?.prompt).toContain("a past note");
  });
});

describe("orchestrator revision parsing", () => {
  test("round-trips a fenced revision and rejects junk", () => {
    const prompt = buildOrchestratorRevisionPrompt(
      {
        v: 1,
        name: "X",
        description: "",
        orchestrator: { enabled: true, instructions: "stay terse" },
        sharing: { mode: "piped", memory: false },
        stages: [],
      },
      [{ kind: "prompt", id: "two", title: "Two", prompt: "p", skills: [] }],
      [{ id: "one", title: "One", status: "ok", summary: "fine" }],
    );
    expect(prompt).toContain("stay terse");
    expect(prompt).toContain("two");

    expect(parseOrchestratorRevision('```json\n[{"id":"two","prompt":"new"}]\n```')).toEqual({
      two: "new",
    });
    expect(parseOrchestratorRevision("no json here")).toBeNull();
    expect(parseOrchestratorRevision('```json\n{"id":"two"}\n```')).toBeNull();
  });
});
