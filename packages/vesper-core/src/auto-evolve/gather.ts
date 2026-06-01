/**
 * The auto-evolve signal gatherer — turns raw store/task reads into a frozen,
 * read-only {@link EvolveSignals} snapshot plus a deterministic, length-capped
 * digest. Pure (the store/task reads are injected seams); issues no writes.
 *
 * The digest is the ONLY thing the handler puts in the reflection prompt. Raw
 * error text is length-capped here and framed as untrusted DATA in the prompt
 * (see `reflect.ts`), mitigating prompt-injection from a malicious `last_error`.
 */

import type { FailedTask, ScheduledTask } from "../scheduler/types.ts";
import type { ListRunsOptions, RunRow } from "../storage/types.ts";
import type { EvolveSignals, PipelineRunRollup, TaskError } from "./types.ts";

/** Read seams injected into {@link gatherSignals} (keeps it pure + unit-testable). */
export interface GatherDeps {
  /** Recent runs (oldest-first). Mirrors `Store.listRuns`. */
  readonly listRuns: (options?: ListRunsOptions) => RunRow[];
  /** Dead-lettered tasks (oldest-first). Mirrors `TaskPersistence.listFailedTasks`. */
  readonly listFailedTasks: () => FailedTask[];
  /** All scheduled tasks. Mirrors `TaskPersistence.list`. */
  readonly listTasks: () => ScheduledTask[];
}

/** Parameters for one gather pass. */
export interface GatherParams {
  /** Inclusive lower bound (unix ms): only signals at/after this are considered. */
  readonly sinceMs: number;
  /** Max recent runs to scan from the store (defaults to 500). */
  readonly limit?: number;
}

/** Cap on a single error field's length inside the digest (prompt-size + injection guard). */
const ERROR_FIELD_CAP = 240;
/** Cap on how many error/failed/task rows the digest enumerates. */
const ROW_CAP = 20;

const DEFAULT_LIMIT = 500;

/** Truncate untrusted text to a hard cap, marking elision. */
function cap(text: string, max = ERROR_FIELD_CAP): string {
  // Collapse newlines so a single signal cannot inject framing into the digest.
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/** Roll up windowed runs into per-pipeline totals + error counts (deterministic order). */
function rollup(runs: readonly RunRow[]): PipelineRunRollup[] {
  const byPipeline = new Map<string, { total: number; errors: number }>();
  for (const r of runs) {
    const entry = byPipeline.get(r.pipeline) ?? { total: 0, errors: 0 };
    entry.total += 1;
    if (r.status === "error") entry.errors += 1;
    byPipeline.set(r.pipeline, entry);
  }
  return [...byPipeline.entries()]
    .map(([pipeline, { total, errors }]) => ({ pipeline, total, errors }))
    .sort((a, b) => a.pipeline.localeCompare(b.pipeline));
}

/** Build the deterministic, length-capped digest from the windowed signals. */
function buildDigest(
  rollups: readonly PipelineRunRollup[],
  failedTasks: readonly FailedTask[],
  taskErrors: readonly TaskError[],
): string {
  const lines: string[] = [];

  lines.push("## Pipeline run roll-up");
  if (rollups.length === 0) {
    lines.push("(no runs in window)");
  } else {
    for (const r of rollups) {
      lines.push(`- ${cap(r.pipeline, 64)}: ${r.total} runs, ${r.errors} errors`);
    }
  }

  lines.push("", "## Dead-lettered tasks");
  if (failedTasks.length === 0) {
    lines.push("(none)");
  } else {
    for (const f of failedTasks.slice(0, ROW_CAP)) {
      lines.push(`- ${cap(f.task_id, 64)} (attempt ${f.attempt_count}): ${cap(f.error)}`);
    }
  }

  lines.push("", "## Per-task last errors");
  if (taskErrors.length === 0) {
    lines.push("(none)");
  } else {
    for (const t of taskErrors.slice(0, ROW_CAP)) {
      lines.push(`- ${cap(t.taskId, 64)} (attempts ${t.attemptCount}): ${cap(t.lastError)}`);
    }
  }

  return lines.join("\n");
}

/**
 * Gather runtime-health signals over `[sinceMs, now]` and return a frozen
 * {@link EvolveSignals} snapshot. Reads only — never writes.
 */
export function gatherSignals(deps: GatherDeps, params: GatherParams): EvolveSignals {
  const { sinceMs } = params;
  const limit = params.limit ?? DEFAULT_LIMIT;

  // listRuns has no time filter, so cap by limit then window in memory (documented pattern).
  const recent = deps.listRuns({ limit });
  const runs = recent.filter((r) => r.ts >= sinceMs);
  const rollups = rollup(runs);

  const failedTasks = deps.listFailedTasks().filter((f) => f.run_at >= sinceMs);

  const taskErrors: TaskError[] = deps
    .listTasks()
    .filter((t): t is ScheduledTask & { last_error: string } => t.enabled && t.last_error !== null)
    .map((t) => ({ taskId: t.id, lastError: t.last_error, attemptCount: t.attempt_count }));

  const digest = buildDigest(rollups, failedTasks, taskErrors);

  return Object.freeze({
    sinceMs,
    runs: Object.freeze(runs),
    rollups: Object.freeze(rollups),
    failedTasks: Object.freeze(failedTasks),
    taskErrors: Object.freeze(taskErrors),
    digest,
  });
}
