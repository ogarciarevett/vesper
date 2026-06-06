/**
 * Tests for createSweBuildHandler, createSoftwareEngineerHandler, and
 * softwareEngineerTaskInput. All seams are injected; no real processes or
 * file I/O occur.
 */

import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import type {
  AppendEventInput,
  CompleteResult,
  PipelineContext,
  ProgressEvent,
  RunParams,
  ScheduledTask,
} from "@vesper/core";
import { ChangeDecisionCoordinator } from "./changes.ts";
import type { CycleDeps, RunTestResult } from "./cycle.ts";
import type { GitRunner } from "./git.ts";
import {
  createSoftwareEngineerHandler,
  createSweBuildHandler,
  type SweBuildDeps,
  softwareEngineerTaskInput,
} from "./handler.ts";
import { LEAD_CAPABILITIES, SOFTWARE_ENGINEER_HANDLER_ID } from "./ids.ts";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function makeCompleteResult(text: string): CompleteResult {
  return { text, exit_code: 0, raw_stdout: text, raw_stderr: "", duration_ms: 0 };
}

function fenced(json: unknown): string {
  return `\`\`\`json\n${JSON.stringify(json)}\n\`\`\``;
}

const FAKE_TASK: ScheduledTask = {
  id: "swe-task",
  kind: "manual",
  schedule_expr: "",
  handler_id: SOFTWARE_ENGINEER_HANDLER_ID,
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
// Minimal fake PipelineContext for build sub-agent tests
// ---------------------------------------------------------------------------

interface RecordedRun {
  status: string;
  summary: string;
}

interface FakeCtx {
  ctx: PipelineContext;
  recordedRuns: RecordedRun[];
  completeCalls: string[];
}

function makeBuildCtx(params: RunParams, completeText: string): FakeCtx {
  const recordedRuns: RecordedRun[] = [];
  const completeCalls: string[] = [];
  const progressEvents: ProgressEvent[] = [];

  const ctx: PipelineContext = {
    runId: "build-run-1",
    parentRunId: "lead-run-1",
    task: FAKE_TASK,
    now: new Date(0),
    params,

    complete(prompt: string): Promise<CompleteResult> {
      completeCalls.push(prompt);
      return Promise.resolve(makeCompleteResult(completeText));
    },

    recordRun(input: { readonly status: string; readonly summary: string }): string {
      recordedRuns.push({ status: input.status, summary: input.summary });
      return "recorded-run-1";
    },

    emitProgress(event: ProgressEvent): void {
      progressEvents.push(event);
    },

    spawn() {
      throw new Error("spawn not expected in build sub-agent tests");
    },

    readSignals() {
      throw new Error("readSignals not used in this test");
    },

    async notify() {
      return { delivered: false as const, reason: "unavailable" as const };
    },
  };

  return { ctx, recordedRuns, completeCalls };
}

// ===========================================================================
// createSweBuildHandler — happy path
// ===========================================================================

describe("createSweBuildHandler happy path", () => {
  test("writes each file to an absolute path inside the worktree", async () => {
    const worktree = "/tmp/wt";
    const writtenFiles: Array<{ absPath: string; contents: string }> = [];
    const deps: SweBuildDeps = {
      writeFile: async (absPath: string, contents: string) => {
        writtenFiles.push({ absPath, contents });
      },
    };
    const handler = createSweBuildHandler(deps);
    const { ctx } = makeBuildCtx(
      { worktree, instruction: "write a", files: ["src/a.ts"] },
      fenced({ files: [{ path: "src/a.ts", contents: "export const a = 1;\n" }] }),
    );

    await handler(ctx);

    expect(writtenFiles).toHaveLength(1);
    expect(writtenFiles[0]?.absPath).toBe(resolve(worktree, "src/a.ts"));
    expect(writtenFiles[0]?.contents).toBe("export const a = 1;\n");
  });

  test("recordRun called with status ok and summary mentioning the file count", async () => {
    const deps: SweBuildDeps = { writeFile: async () => {} };
    const handler = createSweBuildHandler(deps);
    const { ctx, recordedRuns } = makeBuildCtx(
      { worktree: "/tmp/wt", instruction: "write a", files: ["src/a.ts"] },
      fenced({ files: [{ path: "src/a.ts", contents: "ok" }] }),
    );

    await handler(ctx);

    expect(recordedRuns).toHaveLength(1);
    expect(recordedRuns[0]?.status).toBe("ok");
    expect(recordedRuns[0]?.summary).toContain("1");
  });

  test("writes multiple files and recordRun summary reflects the count", async () => {
    const writtenPaths: string[] = [];
    const deps: SweBuildDeps = {
      writeFile: async (p: string) => {
        writtenPaths.push(p);
      },
    };
    const handler = createSweBuildHandler(deps);
    const { ctx, recordedRuns } = makeBuildCtx(
      { worktree: "/tmp/wt", instruction: "write both", files: ["src/a.ts", "src/b.ts"] },
      fenced({
        files: [
          { path: "src/a.ts", contents: "a" },
          { path: "src/b.ts", contents: "b" },
        ],
      }),
    );

    await handler(ctx);

    expect(writtenPaths).toHaveLength(2);
    expect(recordedRuns[0]?.summary).toContain("2");
  });
});

// ===========================================================================
// createSweBuildHandler — parse failure
// ===========================================================================

describe("createSweBuildHandler parse failure", () => {
  test("handler throws when complete returns no fenced block", async () => {
    const writeFileCalls: string[] = [];
    const deps: SweBuildDeps = {
      writeFile: async (p: string) => {
        writeFileCalls.push(p);
      },
    };
    const handler = createSweBuildHandler(deps);
    const { ctx } = makeBuildCtx(
      { worktree: "/tmp/wt", instruction: "x", files: ["src/a.ts"] },
      "no fence here",
    );

    await expect(handler(ctx)).rejects.toThrow();
    expect(writeFileCalls).toHaveLength(0);
  });

  test("recordRun is NOT called when the build output cannot be parsed", async () => {
    const deps: SweBuildDeps = { writeFile: async () => {} };
    const handler = createSweBuildHandler(deps);
    const { ctx, recordedRuns } = makeBuildCtx(
      { worktree: "/tmp/wt", instruction: "x", files: ["src/a.ts"] },
      "no fence here",
    );

    await expect(handler(ctx)).rejects.toThrow();
    expect(recordedRuns).toHaveLength(0);
  });
});

// ===========================================================================
// createSweBuildHandler — path-escape
// ===========================================================================

describe("createSweBuildHandler path-escape", () => {
  test("handler rejects when brain returns a path that escapes the worktree", async () => {
    const writeFileCalls: string[] = [];
    const deps: SweBuildDeps = {
      writeFile: async (p: string) => {
        writeFileCalls.push(p);
      },
    };
    const handler = createSweBuildHandler(deps);
    const { ctx } = makeBuildCtx(
      { worktree: "/tmp/wt", instruction: "x", files: ["src/a.ts"] },
      fenced({ files: [{ path: "../escape.ts", contents: "malicious" }] }),
    );

    await expect(handler(ctx)).rejects.toThrow();
    expect(writeFileCalls).toHaveLength(0);
  });

  test("handler rejects on absolute path outside worktree", async () => {
    const writeFileCalls: string[] = [];
    const deps: SweBuildDeps = {
      writeFile: async (p: string) => {
        writeFileCalls.push(p);
      },
    };
    const handler = createSweBuildHandler(deps);
    const { ctx } = makeBuildCtx(
      { worktree: "/tmp/wt", instruction: "x", files: ["src/a.ts"] },
      fenced({ files: [{ path: "/etc/passwd", contents: "evil" }] }),
    );

    await expect(handler(ctx)).rejects.toThrow();
    expect(writeFileCalls).toHaveLength(0);
  });
});

// ===========================================================================
// createSweBuildHandler — missing params
// ===========================================================================

describe("createSweBuildHandler missing params", () => {
  test("handler rejects with a message naming 'worktree' when that param is absent", async () => {
    const deps: SweBuildDeps = { writeFile: async () => {} };
    const handler = createSweBuildHandler(deps);
    const { ctx } = makeBuildCtx(
      { instruction: "x", files: ["src/a.ts"] },
      fenced({ files: [{ path: "src/a.ts", contents: "ok" }] }),
    );

    await expect(handler(ctx)).rejects.toThrow(/worktree/);
  });

  test("handler rejects with a message naming 'instruction' when that param is absent", async () => {
    const deps: SweBuildDeps = { writeFile: async () => {} };
    const handler = createSweBuildHandler(deps);
    const { ctx } = makeBuildCtx(
      { worktree: "/tmp/wt", files: ["src/a.ts"] },
      fenced({ files: [{ path: "src/a.ts", contents: "ok" }] }),
    );

    await expect(handler(ctx)).rejects.toThrow(/instruction/);
  });

  test("handler rejects with a message naming 'files' when that param is absent", async () => {
    const deps: SweBuildDeps = { writeFile: async () => {} };
    const handler = createSweBuildHandler(deps);
    const { ctx } = makeBuildCtx(
      { worktree: "/tmp/wt", instruction: "x" },
      fenced({ files: [{ path: "src/a.ts", contents: "ok" }] }),
    );

    await expect(handler(ctx)).rejects.toThrow(/files/);
  });
});

// ===========================================================================
// createSoftwareEngineerHandler
// ===========================================================================

describe("createSoftwareEngineerHandler", () => {
  test("calls ctx.recordRun with the runCycle result (error path: no repo)", async () => {
    const recordedRuns: RecordedRun[] = [];
    const appendedEvents: AppendEventInput[] = [];
    const coordinator = new ChangeDecisionCoordinator();
    const fakeGit: GitRunner = async () => ({ stdout: "", stderr: "", exitCode: 0 });

    const cycleDeps: CycleDeps = {
      git: fakeGit,
      appendEvent: (input: AppendEventInput): string => {
        appendedEvents.push(input);
        return "evt-1";
      },
      coordinator,
      runTest: async (_wt): Promise<RunTestResult> => ({ passed: true, summary: "ok" }),
    };

    const handler = createSoftwareEngineerHandler(cycleDeps);

    const ctx: PipelineContext = {
      runId: "lead-run-2",
      parentRunId: null,
      task: FAKE_TASK,
      now: new Date(0),
      params: { wish: "Add something" }, // no repo -> runCycle returns status "error" immediately

      complete(): Promise<CompleteResult> {
        return Promise.resolve(makeCompleteResult("unused"));
      },

      recordRun(input: { readonly status: string; readonly summary: string }): string {
        recordedRuns.push({ status: input.status, summary: input.summary });
        return "recorded-run-lead";
      },

      emitProgress(_event: ProgressEvent): void {},

      spawn() {
        throw new Error("spawn not expected in this error path");
      },

      readSignals() {
        throw new Error("readSignals not used");
      },

      async notify() {
        return { delivered: false as const, reason: "unavailable" as const };
      },
    };

    await handler(ctx);

    expect(recordedRuns).toHaveLength(1);
    expect(recordedRuns[0]?.status).toBe("error");
  });
});

// ===========================================================================
// softwareEngineerTaskInput
// ===========================================================================

describe("softwareEngineerTaskInput", () => {
  test("kind is manual", () => {
    expect(softwareEngineerTaskInput.kind).toBe("manual");
  });

  test("handler_id is SOFTWARE_ENGINEER_HANDLER_ID", () => {
    expect(softwareEngineerTaskInput.handler_id).toBe(SOFTWARE_ENGINEER_HANDLER_ID);
  });

  test("required_capabilities equals LEAD_CAPABILITIES", () => {
    expect(softwareEngineerTaskInput.required_capabilities).toEqual(LEAD_CAPABILITIES);
  });

  test("max_duration_ms is not set (human-approval gate owns the bound)", () => {
    expect(softwareEngineerTaskInput.max_duration_ms).toBeUndefined();
  });
});
