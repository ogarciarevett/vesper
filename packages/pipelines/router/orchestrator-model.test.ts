import { describe, expect, test } from "bun:test";
import type { CompleteResult, PipelineContext, SubAgentHandle } from "@vesper/core";
import { makeRouterHandler } from "./handler.ts";

/**
 * Orchestrator-by-default (specs/pipeline-editor.md): the router's OWN brain
 * calls carry the orchestrator model; a `params.orchestratorModel` wins over the
 * host-injected pick.
 */

interface Recorded {
  readonly prompt: string;
  readonly opts: { model?: string } | undefined;
}

function makeCtx(
  params: Record<string, unknown>,
  reply: string,
): { ctx: PipelineContext; calls: Recorded[] } {
  const calls: Recorded[] = [];
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
    params,
    runId: "r",
    parentRunId: null,
    async complete(prompt, opts): Promise<CompleteResult> {
      calls.push({ prompt, opts });
      return { text: reply, exit_code: 0, raw_stdout: reply, raw_stderr: "", duration_ms: 1 };
    },
    recordRun: () => "r",
    emitProgress: () => {},
    spawn(): SubAgentHandle {
      throw new Error("not used");
    },
    readSignals() {
      throw new Error("not used");
    },
    async notify() {
      return { delivered: false };
    },
  };
  return { ctx, calls };
}

describe("router orchestrator model", () => {
  test("brain calls carry the host-picked orchestrator model", async () => {
    const handler = makeRouterHandler({ pickOrchestratorModel: () => "claude-opus" });
    const { ctx, calls } = makeCtx({ message: "hello" }, "none");
    await handler(ctx);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls[0]?.opts?.model).toBe("claude-opus");
  });

  test("params.orchestratorModel wins over the host pick", async () => {
    const handler = makeRouterHandler({ pickOrchestratorModel: () => "claude-opus" });
    const { ctx, calls } = makeCtx({ message: "hello", orchestratorModel: "gpt" }, "none");
    await handler(ctx);
    expect(calls[0]?.opts?.model).toBe("gpt");
  });

  test("no pick, no param -> no model override (prior behavior)", async () => {
    const handler = makeRouterHandler({});
    const { ctx, calls } = makeCtx({ message: "hello" }, "none");
    await handler(ctx);
    expect(calls[0]?.opts?.model).toBeUndefined();
  });
});
