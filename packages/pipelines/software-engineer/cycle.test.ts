/**
 * End-to-end tests for runCycle.
 *
 * All seams are injected as fakes; no real processes are spawned and no real
 * git binary is invoked. The real ChangeDecisionCoordinator is used for the
 * human-approval gate.
 */

import { describe, expect, test } from "bun:test";
import type {
  AppendEventInput,
  CompleteResult,
  PipelineContext,
  ProgressEvent,
  RunOutcome,
  RunParams,
  ScheduledTask,
  SubAgentDescriptor,
  SubAgentHandle,
} from "@vesper/core";
import { ChangeDecisionCoordinator } from "./changes.ts";
import { type CycleDeps, type CycleResult, type RunTestResult, runCycle } from "./cycle.ts";
import type { GitResult, GitRunner } from "./git.ts";
import { BUILD_CHILD_CAPABILITIES, LEAD_CAPABILITIES, SWE_BUILD_HANDLER_ID } from "./ids.ts";
import type { Worktree } from "./worktree.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const RUN_ID = "11111111-1111-4111-8111-111111111111";
const REPO = "/absolute/fake/repo";
const BASE_DIR = "/tmp/vesper-swe-test";

const SPEC_REPLY = `\`\`\`json\n{"title":"Add foo","body":"do the thing"}\n\`\`\``;
const PLAN_REPLY = `\`\`\`json\n{"tasks":[{"id":"t1","files":["src/a.ts"],"instruction":"write a"}]}\n\`\`\``;
const REVIEW_REPLY = "LGTM. No issues found.";

/** Minimal unified diff that parseUnifiedDiff parses into exactly one file. */
const FAKE_DIFF = [
  "diff --git a/src/a.ts b/src/a.ts",
  "new file mode 100644",
  "--- /dev/null",
  "+++ b/src/a.ts",
  "@@ -0,0 +1,2 @@",
  "+export const a = 1;",
  "+export const b = 2;",
].join("\n");

// ---------------------------------------------------------------------------
// CompleteResult factory
// ---------------------------------------------------------------------------

function makeCompleteResult(text: string): CompleteResult {
  return { text, exit_code: 0, raw_stdout: text, raw_stderr: "", duration_ms: 0 };
}

// ---------------------------------------------------------------------------
// Fake ScheduledTask
// ---------------------------------------------------------------------------

const FAKE_TASK: ScheduledTask = {
  id: "swe-task",
  kind: "manual",
  schedule_expr: "",
  handler_id: "software-engineer",
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
  required_capabilities: LEAD_CAPABILITIES,
};

// ---------------------------------------------------------------------------
// makeCtx
// ---------------------------------------------------------------------------

interface RecordedRun {
  status: string;
  summary: string;
}

interface SpawnCall {
  descriptor: SubAgentDescriptor;
}

interface MakeCtxResult {
  ctx: PipelineContext;
  completeCalls: string[];
  recordedRuns: RecordedRun[];
  progressEvents: ProgressEvent[];
  spawnCalls: SpawnCall[];
}

interface MakeCtxOpts {
  params?: RunParams;
  completeReplies?: CompleteResult[];
  spawnDone?: (descriptor: SubAgentDescriptor, index: number) => Promise<RunOutcome>;
}

function makeCtx(opts: MakeCtxOpts): MakeCtxResult {
  const completeCalls: string[] = [];
  const recordedRuns: RecordedRun[] = [];
  const progressEvents: ProgressEvent[] = [];
  const spawnCalls: SpawnCall[] = [];

  const replies: CompleteResult[] = opts.completeReplies ?? [
    makeCompleteResult(SPEC_REPLY),
    makeCompleteResult(PLAN_REPLY),
    makeCompleteResult(REVIEW_REPLY),
  ];

  let completionIndex = 0;
  let spawnIndex = 0;

  const ctx: PipelineContext = {
    runId: RUN_ID,
    parentRunId: null,
    task: FAKE_TASK,
    now: new Date(0),
    params: opts.params ?? { repo: REPO, wish: "Add foo feature" },

    complete(prompt: string): Promise<CompleteResult> {
      completeCalls.push(prompt);
      const result = replies[completionIndex++];
      if (result === undefined) {
        return Promise.reject(
          new Error(`complete called more times than scripted replies (call #${completionIndex})`),
        );
      }
      return Promise.resolve(result);
    },

    recordRun(input: { readonly status: string; readonly summary: string }): string {
      recordedRuns.push({ status: input.status, summary: input.summary });
      return `recorded-run-${recordedRuns.length}`;
    },

    emitProgress(event: ProgressEvent): void {
      progressEvents.push(event);
    },

    spawn(descriptor: SubAgentDescriptor): SubAgentHandle {
      const idx = spawnIndex++;
      spawnCalls.push({ descriptor });
      const done: Promise<RunOutcome> = opts.spawnDone
        ? opts.spawnDone(descriptor, idx)
        : Promise.resolve<RunOutcome>({
            taskId: descriptor.handlerId,
            runId: `child-run-${idx}`,
            status: "ok",
            summary: "build task ok",
            cli: null,
            durationMs: 1,
          });
      return {
        runId: `child-run-${idx}`,
        handlerId: descriptor.handlerId,
        label: descriptor.label,
        done,
      };
    },

    readSignals(_opts?: { readonly windowMs?: number }) {
      throw new Error("readSignals not used in this test");
    },

    async notify() {
      return { delivered: false as const, reason: "unavailable" as const };
    },
  };

  return { ctx, completeCalls, recordedRuns, progressEvents, spawnCalls };
}

// ---------------------------------------------------------------------------
// makeGit
// ---------------------------------------------------------------------------

interface GitCall {
  cwd: string;
  args: readonly string[];
}

interface MakeGitResult {
  git: GitRunner;
  calls: GitCall[];
}

function makeGit(): MakeGitResult {
  const calls: GitCall[] = [];
  const git: GitRunner = async (
    cwd: string,
    args: readonly string[],
    _opts?: { readonly timeoutMs?: number },
  ): Promise<GitResult> => {
    calls.push({ cwd, args });
    if (args[0] === "diff") {
      return { stdout: FAKE_DIFF, stderr: "", exitCode: 0 };
    }
    return { stdout: "", stderr: "", exitCode: 0 };
  };
  return { git, calls };
}

// ---------------------------------------------------------------------------
// Poll helper: wait until coordinator registers a waiter
// ---------------------------------------------------------------------------

async function pollUntilHas(
  coordinator: ChangeDecisionCoordinator,
  runId: string,
  changeId: string,
  maxMs = 500,
): Promise<boolean> {
  const deadline = Date.now() + maxMs;
  while (!coordinator.has(runId, changeId) && Date.now() < deadline) {
    await new Promise<void>((r) => setTimeout(r, 1));
  }
  return coordinator.has(runId, changeId);
}

// ---------------------------------------------------------------------------
// makeHappyDeps: default CycleDeps with overridable fields
// ---------------------------------------------------------------------------

function makeHappyDeps(
  coordinator: ChangeDecisionCoordinator,
  git: GitRunner,
  appendedEvents: AppendEventInput[],
  extra?: Partial<CycleDeps>,
): CycleDeps {
  return {
    git,
    appendEvent: (input: AppendEventInput): string => {
      appendedEvents.push(input);
      return `evt-${appendedEvents.length}`;
    },
    coordinator,
    runTest: async (_wt: Worktree): Promise<RunTestResult> => ({
      passed: true,
      summary: "all tests passed",
    }),
    baseDir: BASE_DIR,
    approvalTimeoutMs: 5000,
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// Convenience: build a full test setup in one call
// ---------------------------------------------------------------------------

interface TestSetup extends MakeCtxResult {
  coordinator: ChangeDecisionCoordinator;
  gitCalls: GitCall[];
  appendedEvents: AppendEventInput[];
  deps: CycleDeps;
}

function makeTestSetup(ctxOpts?: MakeCtxOpts, extraDeps?: Partial<CycleDeps>): TestSetup {
  const coordinator = new ChangeDecisionCoordinator();
  const { git, calls: gitCalls } = makeGit();
  const appendedEvents: AppendEventInput[] = [];
  const ctxResult = makeCtx(ctxOpts ?? {});
  const deps = makeHappyDeps(coordinator, git, appendedEvents, extraDeps);
  return { coordinator, gitCalls, appendedEvents, deps, ...ctxResult };
}

// ===========================================================================
// happy approve path
// ===========================================================================

describe("runCycle — happy approve path", () => {
  test("status is shipped and summary mentions the worktree branch and a feat: commit", async () => {
    const { coordinator, ctx, deps } = makeTestSetup();
    const changeId = `${RUN_ID}:build`;

    const cyclePromise = runCycle(ctx, deps);
    expect(await pollUntilHas(coordinator, RUN_ID, changeId)).toBe(true);
    coordinator.resolve(RUN_ID, changeId, { decision: "approve" });
    const result: CycleResult = await cyclePromise;

    expect(result.status).toBe("shipped");
    expect(result.summary).toContain(`vesper/swe-${RUN_ID}`);
    expect(result.summary).toContain("feat:");
  });

  test("git received add -N, diff, and add -A all on the worktree path", async () => {
    const { coordinator, ctx, deps, gitCalls } = makeTestSetup();
    const changeId = `${RUN_ID}:build`;
    const worktreePath = `${BASE_DIR}/${RUN_ID}`;

    const cyclePromise = runCycle(ctx, deps);
    await pollUntilHas(coordinator, RUN_ID, changeId);
    coordinator.resolve(RUN_ID, changeId, { decision: "approve" });
    await cyclePromise;

    const wtCalls = gitCalls.filter((c) => c.cwd === worktreePath);
    expect(wtCalls.some((c) => c.args[0] === "add" && c.args[1] === "-N")).toBe(true);
    expect(wtCalls.some((c) => c.args[0] === "diff")).toBe(true);
    expect(wtCalls.some((c) => c.args[0] === "add" && c.args[1] === "-A")).toBe(true);
  });

  test("spawn called once with SWE_BUILD_HANDLER_ID, BUILD_CHILD_CAPABILITIES, and worktree param", async () => {
    const { coordinator, ctx, deps, spawnCalls } = makeTestSetup();
    const changeId = `${RUN_ID}:build`;

    const cyclePromise = runCycle(ctx, deps);
    await pollUntilHas(coordinator, RUN_ID, changeId);
    coordinator.resolve(RUN_ID, changeId, { decision: "approve" });
    await cyclePromise;

    expect(spawnCalls).toHaveLength(1);
    const desc = spawnCalls[0]?.descriptor;
    expect(desc?.handlerId).toBe(SWE_BUILD_HANDLER_ID);
    expect(desc?.capabilities).toEqual(BUILD_CHILD_CAPABILITIES);
    expect(desc?.params?.worktree).toBe(`${BASE_DIR}/${RUN_ID}`);
  });

  test("runTest was called once after approval", async () => {
    let runTestCalled = false;
    const { coordinator, ctx, deps } = makeTestSetup(undefined, {
      runTest: async (_wt) => {
        runTestCalled = true;
        return { passed: true, summary: "ok" };
      },
    });
    const changeId = `${RUN_ID}:build`;

    const cyclePromise = runCycle(ctx, deps);
    await pollUntilHas(coordinator, RUN_ID, changeId);
    coordinator.resolve(RUN_ID, changeId, { decision: "approve" });
    await cyclePromise;

    expect(runTestCalled).toBe(true);
  });

  test("swe_change_proposed payload has changeId, contentHash, and files", async () => {
    const { coordinator, ctx, deps, appendedEvents } = makeTestSetup();
    const changeId = `${RUN_ID}:build`;

    const cyclePromise = runCycle(ctx, deps);
    await pollUntilHas(coordinator, RUN_ID, changeId);
    coordinator.resolve(RUN_ID, changeId, { decision: "approve" });
    await cyclePromise;

    const proposed = appendedEvents.find((e) => e.kind === "swe_change_proposed");
    expect(proposed).toBeDefined();
    expect(proposed?.payload?.changeId).toBe(`${RUN_ID}:build`);
    expect(typeof proposed?.payload?.contentHash).toBe("string");
    expect(Array.isArray(proposed?.payload?.files)).toBe(true);
  });

  test("all required event kinds are present in appendedEvents", async () => {
    const { coordinator, ctx, deps, appendedEvents } = makeTestSetup();
    const changeId = `${RUN_ID}:build`;

    const cyclePromise = runCycle(ctx, deps);
    await pollUntilHas(coordinator, RUN_ID, changeId);
    coordinator.resolve(RUN_ID, changeId, { decision: "approve" });
    await cyclePromise;

    const kinds = appendedEvents.map((e) => e.kind);
    expect(kinds).toContain("swe_step");
    expect(kinds).toContain("swe_change_proposed");
    expect(kinds).toContain("swe_change_approved");
    expect(kinds).toContain("swe_improve");
    expect(kinds).toContain("swe_committed");
  });
});

// ===========================================================================
// reject path
// ===========================================================================

describe("runCycle — reject path", () => {
  test("status is rejected and summary contains the rejection reason", async () => {
    const { coordinator, ctx, deps } = makeTestSetup();
    const changeId = `${RUN_ID}:build`;

    const cyclePromise = runCycle(ctx, deps);
    await pollUntilHas(coordinator, RUN_ID, changeId);
    coordinator.resolve(RUN_ID, changeId, { decision: "reject", reason: "nope" });
    const result = await cyclePromise;

    expect(result.status).toBe("rejected");
    expect(result.summary).toContain("nope");
  });

  test("swe_change_rejected event emitted with the reason", async () => {
    const { coordinator, ctx, deps, appendedEvents } = makeTestSetup();
    const changeId = `${RUN_ID}:build`;

    const cyclePromise = runCycle(ctx, deps);
    await pollUntilHas(coordinator, RUN_ID, changeId);
    coordinator.resolve(RUN_ID, changeId, { decision: "reject", reason: "nope" });
    await cyclePromise;

    const rejected = appendedEvents.find((e) => e.kind === "swe_change_rejected");
    expect(rejected).toBeDefined();
    expect(rejected?.payload?.reason).toBe("nope");
  });

  test("git received restore --staged . after rejection", async () => {
    const { coordinator, ctx, deps, gitCalls } = makeTestSetup();
    const changeId = `${RUN_ID}:build`;

    const cyclePromise = runCycle(ctx, deps);
    await pollUntilHas(coordinator, RUN_ID, changeId);
    coordinator.resolve(RUN_ID, changeId, { decision: "reject", reason: "nope" });
    await cyclePromise;

    expect(gitCalls.some((c) => c.args[0] === "restore" && c.args[1] === "--staged")).toBe(true);
  });

  test("runTest NOT called after rejection", async () => {
    let runTestCalled = false;
    const { coordinator, ctx, deps } = makeTestSetup(undefined, {
      runTest: async (_wt) => {
        runTestCalled = true;
        return { passed: true, summary: "ok" };
      },
    });
    const changeId = `${RUN_ID}:build`;

    const cyclePromise = runCycle(ctx, deps);
    await pollUntilHas(coordinator, RUN_ID, changeId);
    coordinator.resolve(RUN_ID, changeId, { decision: "reject", reason: "nope" });
    await cyclePromise;

    expect(runTestCalled).toBe(false);
  });

  test("swe_committed NOT emitted after rejection", async () => {
    const { coordinator, ctx, deps, appendedEvents } = makeTestSetup();
    const changeId = `${RUN_ID}:build`;

    const cyclePromise = runCycle(ctx, deps);
    await pollUntilHas(coordinator, RUN_ID, changeId);
    coordinator.resolve(RUN_ID, changeId, { decision: "reject", reason: "nope" });
    await cyclePromise;

    expect(appendedEvents.find((e) => e.kind === "swe_committed")).toBeUndefined();
  });
});

// ===========================================================================
// gate timeout
// ===========================================================================

describe("runCycle — gate timeout", () => {
  test("status is awaiting_review_timeout when no decision arrives before timeout", async () => {
    const { ctx, deps } = makeTestSetup(undefined, { approvalTimeoutMs: 10 });
    const result = await runCycle(ctx, deps);
    expect(result.status).toBe("awaiting_review_timeout");
  });

  test("worktree remove NOT called on timeout (worktree preserved for inspection)", async () => {
    const { ctx, deps, gitCalls } = makeTestSetup(undefined, { approvalTimeoutMs: 10 });
    await runCycle(ctx, deps);
    expect(gitCalls.some((c) => c.args[0] === "worktree" && c.args[1] === "remove")).toBe(false);
  });

  test("runTest NOT called on timeout", async () => {
    let runTestCalled = false;
    const { ctx, deps } = makeTestSetup(undefined, {
      approvalTimeoutMs: 10,
      runTest: async (_wt) => {
        runTestCalled = true;
        return { passed: true, summary: "ok" };
      },
    });

    await runCycle(ctx, deps);

    expect(runTestCalled).toBe(false);
  });
});

// ===========================================================================
// test fails after approval
// ===========================================================================

describe("runCycle — test fails after approval", () => {
  test("status is test_failed when runTest returns passed:false", async () => {
    const { coordinator, ctx, deps } = makeTestSetup(undefined, {
      runTest: async (_wt) => ({ passed: false, summary: "boom" }),
    });
    const changeId = `${RUN_ID}:build`;

    const cyclePromise = runCycle(ctx, deps);
    await pollUntilHas(coordinator, RUN_ID, changeId);
    coordinator.resolve(RUN_ID, changeId, { decision: "approve" });
    const result = await cyclePromise;

    expect(result.status).toBe("test_failed");
  });

  test("swe_committed NOT emitted when test fails", async () => {
    const { coordinator, ctx, deps, appendedEvents } = makeTestSetup(undefined, {
      runTest: async (_wt) => ({ passed: false, summary: "boom" }),
    });
    const changeId = `${RUN_ID}:build`;

    const cyclePromise = runCycle(ctx, deps);
    await pollUntilHas(coordinator, RUN_ID, changeId);
    coordinator.resolve(RUN_ID, changeId, { decision: "approve" });
    await cyclePromise;

    expect(appendedEvents.find((e) => e.kind === "swe_committed")).toBeUndefined();
  });

  test("swe_change_approved IS emitted and git add -A ran before the test failure", async () => {
    const { coordinator, ctx, deps, appendedEvents, gitCalls } = makeTestSetup(undefined, {
      runTest: async (_wt) => ({ passed: false, summary: "boom" }),
    });
    const changeId = `${RUN_ID}:build`;

    const cyclePromise = runCycle(ctx, deps);
    await pollUntilHas(coordinator, RUN_ID, changeId);
    coordinator.resolve(RUN_ID, changeId, { decision: "approve" });
    await cyclePromise;

    expect(appendedEvents.find((e) => e.kind === "swe_change_approved")).toBeDefined();
    expect(gitCalls.some((c) => c.args[0] === "add" && c.args[1] === "-A")).toBe(true);
  });
});

// ===========================================================================
// precondition errors
// ===========================================================================

describe("runCycle — missing repo", () => {
  test("status is error and summary mentions absolute path when repo is absent", async () => {
    const { ctx, deps } = makeTestSetup({ params: { wish: "Add foo" } });
    const result = await runCycle(ctx, deps);
    expect(result.status).toBe("error");
    expect(result.summary.toLowerCase()).toContain("absolute");
  });

  test("status is error when repo is a relative path", async () => {
    const { ctx, deps } = makeTestSetup({ params: { repo: "relative/path", wish: "Add foo" } });
    const result = await runCycle(ctx, deps);
    expect(result.status).toBe("error");
    expect(result.summary.toLowerCase()).toContain("absolute");
  });

  test("createWorktree (git worktree add) is NEVER called when repo is missing", async () => {
    const { ctx, deps, gitCalls } = makeTestSetup({ params: { wish: "Add foo" } });
    await runCycle(ctx, deps);
    expect(gitCalls.some((c) => c.args[0] === "worktree" && c.args[1] === "add")).toBe(false);
  });
});

describe("runCycle — no wish", () => {
  test("status is error when neither wish nor fixProposalId is provided", async () => {
    const { ctx, deps } = makeTestSetup({ params: { repo: REPO } });
    const result = await runCycle(ctx, deps);
    expect(result.status).toBe("error");
  });

  test("worktree add is NEVER called when no seed is provided", async () => {
    const { ctx, deps, gitCalls } = makeTestSetup({ params: { repo: REPO } });
    await runCycle(ctx, deps);
    expect(gitCalls.some((c) => c.args[0] === "worktree" && c.args[1] === "add")).toBe(false);
  });
});

// ===========================================================================
// fixProposalId path
// ===========================================================================

describe("runCycle — fixProposalId path", () => {
  test("proceeds to SPEC (complete called) when fixProposalId resolves to a seed", async () => {
    const { ctx, deps, completeCalls } = makeTestSetup(
      { params: { repo: REPO, fixProposalId: "f1" } },
      {
        loadFixProposal: (id: string) => (id === "f1" ? "fix this bug" : null),
        approvalTimeoutMs: 10,
      },
    );

    await runCycle(ctx, deps);

    expect(completeCalls.length).toBeGreaterThanOrEqual(1);
  });

  test("status is error when fixProposalId resolves to null", async () => {
    const { ctx, deps } = makeTestSetup(
      { params: { repo: REPO, fixProposalId: "unknown" } },
      { loadFixProposal: () => null },
    );
    const result = await runCycle(ctx, deps);
    expect(result.status).toBe("error");
  });
});

// ===========================================================================
// SPEC unparseable
// ===========================================================================

describe("runCycle — SPEC unparseable", () => {
  test("status is no_change and summary mentions SPEC", async () => {
    const { ctx, deps } = makeTestSetup({
      completeReplies: [makeCompleteResult("no spec json here")],
    });
    const result = await runCycle(ctx, deps);
    expect(result.status).toBe("no_change");
    expect(result.summary.toUpperCase()).toContain("SPEC");
  });

  test("complete called exactly once (only the SPEC prompt)", async () => {
    const { ctx, deps, completeCalls } = makeTestSetup({
      completeReplies: [makeCompleteResult("no spec json here")],
    });
    await runCycle(ctx, deps);
    expect(completeCalls).toHaveLength(1);
  });

  test("worktree remove IS called (cleanup on no-change)", async () => {
    const { ctx, deps, gitCalls } = makeTestSetup({
      completeReplies: [makeCompleteResult("no spec json here")],
    });
    await runCycle(ctx, deps);
    expect(gitCalls.some((c) => c.args[0] === "worktree" && c.args[1] === "remove")).toBe(true);
  });
});

// ===========================================================================
// PLAN unparseable
// ===========================================================================

describe("runCycle — PLAN unparseable", () => {
  test("status is no_change and summary mentions PLAN", async () => {
    const { ctx, deps } = makeTestSetup({
      completeReplies: [makeCompleteResult(SPEC_REPLY), makeCompleteResult("no plan json here")],
    });
    const result = await runCycle(ctx, deps);
    expect(result.status).toBe("no_change");
    expect(result.summary.toUpperCase()).toContain("PLAN");
  });

  test("complete called exactly twice (SPEC + PLAN)", async () => {
    const { ctx, deps, completeCalls } = makeTestSetup({
      completeReplies: [makeCompleteResult(SPEC_REPLY), makeCompleteResult("no plan json here")],
    });
    await runCycle(ctx, deps);
    expect(completeCalls).toHaveLength(2);
  });

  test("worktree remove IS called after PLAN failure", async () => {
    const { ctx, deps, gitCalls } = makeTestSetup({
      completeReplies: [makeCompleteResult(SPEC_REPLY), makeCompleteResult("no plan json here")],
    });
    await runCycle(ctx, deps);
    expect(gitCalls.some((c) => c.args[0] === "worktree" && c.args[1] === "remove")).toBe(true);
  });
});

// ===========================================================================
// all BUILD tasks fail
// ===========================================================================

describe("runCycle — all BUILD tasks fail", () => {
  test("status is build_failed when every spawn handle rejects", async () => {
    const { ctx, deps } = makeTestSetup({
      spawnDone: async () => {
        throw new Error("build task failed");
      },
    });
    const result = await runCycle(ctx, deps);
    expect(result.status).toBe("build_failed");
  });

  test("coordinator gate is NOT entered and swe_change_proposed is NOT emitted", async () => {
    const { ctx, deps, coordinator, appendedEvents } = makeTestSetup({
      spawnDone: async () => {
        throw new Error("build task failed");
      },
    });

    await runCycle(ctx, deps);

    expect(coordinator.has(RUN_ID, `${RUN_ID}:build`)).toBe(false);
    expect(appendedEvents.find((e) => e.kind === "swe_change_proposed")).toBeUndefined();
  });
});
