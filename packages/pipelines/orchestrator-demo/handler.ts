/**
 * The `orchestrator-demo` pipeline — a runnable demonstration of the sub-agent
 * orchestration + live-trace backbone (per-task grants + agent-orchestration-and-trace).
 *
 * The parent emits a couple of live-trace steps, fans out one sub-agent per stage
 * (`research` / `draft` / `review`), then records the run. Each sub-agent emits its
 * own live steps under its own `runs` row, so `vesper ui` renders the real-time
 * orchestration tree: the parent plus every sub-agent streaming as it works.
 *
 * It performs NO real work and needs NO CLI — the workers only `emitProgress` +
 * `recordRun` (capability `WRITE_STORAGE`), so the demo runs on any machine. Modest
 * per-step delays make the streaming watchable; pass `params.instant = true` to skip
 * them (used by tests). The parent forwards `instant` to each child via descriptor
 * params, exercising the descriptor-params -> child-context path.
 */

import type { RegisterTaskInput, RunParams, TaskHandler } from "@vesper/core";

/** Allowlisted handler id for the top-level orchestrator. */
export const ORCHESTRATOR_DEMO_HANDLER_ID = "orchestrator-demo";
/** Allowlisted handler id for the spawn-only demo worker (no scheduled task). */
export const DEMO_WORKER_HANDLER_ID = "demo-worker";

/** Illustrative fan-out stages, one sub-agent each. */
const STAGES = ["research", "draft", "review"] as const;

/** Per-step delay (ms) that makes the live stream watchable in the UI. */
const STEP_DELAY_MS = 220;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** True when the run asked to skip the watchability delays (tests). */
function isInstant(params: RunParams): boolean {
  return params.instant === true;
}

/**
 * Spawn-only demo worker. Emits a few live-trace steps for its stage, then records
 * its run. Granted only `WRITE_STORAGE` when spawned — it never touches a CLI.
 */
export const demoWorkerHandler: TaskHandler = async (ctx) => {
  const stage = typeof ctx.params.stage === "string" ? ctx.params.stage : "work";
  const instant = isInstant(ctx.params);

  ctx.emitProgress({ kind: "step", message: `${stage}: starting` });
  if (!instant) await delay(STEP_DELAY_MS);
  ctx.emitProgress({ kind: "progress", message: `${stage}: working`, data: { pct: 50 } });
  if (!instant) await delay(STEP_DELAY_MS);
  ctx.emitProgress({ kind: "step", message: `${stage}: done` });
  ctx.recordRun({ status: "ok", summary: `${stage} complete` });
};

/**
 * Orchestrator-demo handler. Fans out one {@link demoWorkerHandler} per stage and
 * waits for all of them; the run is `ok` when every sub-agent finished, else `partial`.
 */
export const orchestratorDemoHandler: TaskHandler = async (ctx) => {
  const instant = isInstant(ctx.params);

  ctx.emitProgress({ kind: "step", message: "planning the fan-out" });
  const handles = STAGES.map((stage) =>
    ctx.spawn({
      handlerId: DEMO_WORKER_HANDLER_ID,
      label: stage,
      params: { stage, instant },
      capabilities: ["WRITE_STORAGE"],
    }),
  );
  ctx.emitProgress({
    kind: "step",
    message: `spawned ${handles.length} sub-agents`,
    data: { stages: [...STAGES] },
  });

  const results = await Promise.allSettled(handles.map((h) => h.done));
  const ok = results.filter((r) => r.status === "fulfilled").length;
  ctx.recordRun({
    status: ok === handles.length ? "ok" : "partial",
    summary: `${ok}/${handles.length} sub-agents finished`,
  });
};

/**
 * Manual task wiring for the orchestrator demo. Requires `SPAWN_SUBAGENT` (to fan
 * out) and `WRITE_STORAGE` (to record + emit trace). The workers are granted a
 * subset (`WRITE_STORAGE` only) at spawn time.
 */
export const orchestratorDemoTaskInput: RegisterTaskInput = {
  id: "orchestrator-demo",
  kind: "manual",
  schedule_expr: "",
  handler_id: ORCHESTRATOR_DEMO_HANDLER_ID,
  max_duration_ms: 30_000,
  required_capabilities: ["SPAWN_SUBAGENT", "WRITE_STORAGE"],
};
