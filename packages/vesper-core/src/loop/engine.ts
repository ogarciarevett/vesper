/**
 * The autonomous-loop engine — `runLoop` drives AUTHOR -> EXECUTE -> CRITIC
 * iterations over `PipelineContext.complete` until the critic declares the
 * objective met or a hard bound trips.
 *
 * Pure over the existing context: the only side effects are `ctx.complete`
 * (CLI_INVOKE), `ctx.emitProgress`/`ctx.recordRun` (WRITE_STORAGE), and the
 * injected per-iteration audit writer (metadata granularity — never the authored
 * prompt body, the execution text, or any secret).
 */

import type { PipelineContext } from "../scheduler/types.ts";
import { authorPrompt, criticPrompt, parseVerdict } from "./prompts.ts";
import {
  LOOP_DEFAULT_MAX_NO_PROGRESS,
  LOOP_MAX_ITERATIONS_CEILING,
  type LoopDeps,
  type LoopIteration,
  type LoopResult,
  type LoopSpec,
  type LoopStatus,
} from "./types.ts";

/** Cap on the execution text carried in the transcript / final output. */
const EXECUTION_SUMMARY_MAX = 2_000;
/** Head of the final output quoted into the one-line run summary. */
const RUN_SUMMARY_HEAD = 200;

/** Clamp the requested iteration cap into [1, ceiling]. */
function clampIterations(requested: number): number {
  if (!Number.isFinite(requested)) return 1;
  return Math.min(LOOP_MAX_ITERATIONS_CEILING, Math.max(1, Math.floor(requested)));
}

/** One-line head of a possibly multi-line text. */
function head(text: string, max: number): string {
  return text.replace(/\s+/g, " ").trim().slice(0, max);
}

/**
 * Run one bounded autonomous loop. Per iteration: AUTHOR writes the next prompt,
 * EXECUTE runs it, CRITIC returns a fail-closed verdict; each role emits a
 * live-trace step and the iteration appends exactly one audit `events` row.
 *
 * Stop checks, in order: `verdict.done` -> `succeeded`; no critic progress for
 * `maxNoProgress` consecutive iterations -> `stalled`; the iteration cap ->
 * `exhausted`; the wall-clock budget -> `aborted`. On exit the run is recorded
 * with a one-line summary.
 */
export async function runLoop(
  ctx: PipelineContext,
  spec: LoopSpec,
  deps: LoopDeps = {},
): Promise<LoopResult> {
  if (spec.objective.goal.trim().length === 0) {
    throw new Error("loop objective `goal` must be a non-empty string");
  }
  const maxIterations = clampIterations(spec.bounds.maxIterations);
  const maxNoProgress = spec.bounds.maxNoProgress ?? LOOP_DEFAULT_MAX_NO_PROGRESS;
  const maxTotalMs = spec.bounds.maxTotalMs;
  const now = deps.now ?? Date.now;
  const startedAt = now();

  const completeFor = async (prompt: string, cli: string | undefined) =>
    ctx.complete(prompt, cli !== undefined ? { cli } : undefined);

  const iterations: LoopIteration[] = [];
  let bestProgress = 0;
  let stalls = 0;
  let status: LoopStatus | null = null;
  let finalOutput = "";

  for (let index = 1; index <= maxIterations; index++) {
    // AUTHOR — the model writes the next operational prompt.
    const authored = await completeFor(
      authorPrompt(spec.objective, iterations),
      spec.roles?.authorCli,
    );
    const authoredPrompt = authored.text.trim();
    ctx.emitProgress({
      kind: "step",
      message: `iteration ${index}: authored next prompt`,
      data: { iteration: index },
    });

    // EXECUTE — run the authored prompt verbatim.
    const executed = await completeFor(
      authoredPrompt.length > 0 ? authoredPrompt : "(the author produced an empty prompt)",
      spec.roles?.executeCli,
    );
    const executionSummary =
      executed.text.trim().slice(0, EXECUTION_SUMMARY_MAX) || "(empty response)";
    ctx.emitProgress({
      kind: "log",
      message: `iteration ${index}: executed authored prompt`,
      data: { iteration: index },
    });

    // CRITIC — judge the result against the objective, fail-closed.
    const judged = await completeFor(
      criticPrompt(spec.objective, authoredPrompt, executionSummary),
      spec.roles?.criticCli,
    );
    const verdict = parseVerdict(judged.text, bestProgress);
    ctx.emitProgress({
      kind: "progress",
      message: `iteration ${index}: critic ${verdict.done ? "done" : `progress ${verdict.progress}/100`}`,
      data: { iteration: index, done: verdict.done, progress: verdict.progress },
    });

    iterations.push({ index, authoredPrompt, executionSummary, verdict });
    finalOutput = executionSummary;

    // Stop checks (spec order: done -> stalled -> exhausted -> aborted).
    if (verdict.done) {
      status = "succeeded";
    } else if (verdict.progress > bestProgress) {
      bestProgress = verdict.progress;
      stalls = 0;
    } else {
      stalls += 1;
      if (stalls >= maxNoProgress) status = "stalled";
    }
    if (status === null && index < maxIterations && maxTotalMs !== undefined) {
      if (now() - startedAt >= maxTotalMs) status = "aborted";
    }

    // Audit row at metadata granularity — never prompt/result bodies.
    deps.appendEvent?.({
      source: "loop",
      kind: "loop_iteration",
      payload: {
        iteration: index,
        status: status ?? "continue",
        done: verdict.done,
        progress: verdict.progress,
      },
    });

    if (status !== null) break;
  }

  const finalStatus: LoopStatus = status ?? "exhausted";
  ctx.recordRun({
    status: finalStatus,
    summary: `${finalStatus} after ${iterations.length} iteration(s): ${head(finalOutput, RUN_SUMMARY_HEAD)}`,
  });

  return { status: finalStatus, iterations, finalOutput };
}
