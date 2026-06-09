/**
 * The `benchmark-ingest` pipeline — the daily model-intelligence snapshot
 * (`specs/orchestrator-home.md`, slice D).
 *
 * Fetches the ONLY trusted leaderboard (DeepSWE, Omar's call) through
 * `allowlistedFetch` — host-allowlisted to `deepswe.datacurve.ai`, gated on
 * `NETWORK_FETCH` — parses the rows fail-soft (a malformed row is skipped), and
 * replaces the local snapshot atomically. The orchestrator consults the snapshot
 * via `selectModel` to pick a model by cost + intelligence per task.
 *
 * This is NOT an LLM call (Hard rule 12 untouched): the fetch is first-party
 * JSON the user opts into, the same egress class as channel handlers.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import {
  allowlistedFetch,
  BENCHMARK_ALLOWED_HOSTS,
  BENCHMARK_SOURCE,
  BENCHMARK_URL,
  type FetchFn,
  type ModelBenchmarkInput,
  openStore,
  parseLeaderboard,
  type RegisterTaskInput,
  type TaskHandler,
} from "@vesper/core";

/** Allowlisted handler id referenced by the `benchmark-ingest` task. */
export const BENCHMARK_INGEST_HANDLER_ID = "benchmark-ingest";

/** Injected seams so the handler is unit-testable with no real DB or network. */
export interface BenchmarkIngestDeps {
  /** Replace the snapshot for a source; returns the row count (store seam). */
  readonly replaceBenchmarks: (source: string, rows: readonly ModelBenchmarkInput[]) => number;
  /** Fetch implementation handed to `allowlistedFetch`. Omit for the real fetch. */
  readonly fetchFn?: FetchFn;
}

/** Build the `benchmark-ingest` handler with injected store/network seams. */
export function createBenchmarkIngestHandler(deps: BenchmarkIngestDeps): TaskHandler {
  return async (ctx) => {
    const response = await allowlistedFetch({
      url: BENCHMARK_URL,
      allowedHosts: BENCHMARK_ALLOWED_HOSTS,
      granted: ctx.task.required_capabilities,
      ...(deps.fetchFn !== undefined ? { fetchFn: deps.fetchFn } : {}),
    });
    if (!response.ok) {
      ctx.recordRun({
        status: "error",
        summary: `leaderboard fetch failed: HTTP ${response.status}`,
      });
      return;
    }

    let json: unknown;
    try {
      json = await response.json();
    } catch {
      ctx.recordRun({ status: "error", summary: "leaderboard response was not valid JSON" });
      return;
    }

    const rows = parseLeaderboard(json);
    if (rows.length === 0) {
      // Fail-soft: keep the previous snapshot rather than replacing it with nothing.
      ctx.recordRun({
        status: "no_change",
        summary: "leaderboard had no parseable rows — kept the previous snapshot",
      });
      return;
    }

    const count = deps.replaceBenchmarks(BENCHMARK_SOURCE, rows);
    ctx.emitProgress({
      kind: "step",
      message: `ingested ${count} benchmark rows from ${BENCHMARK_SOURCE}`,
    });
    ctx.recordRun({ status: "ok", summary: `${count} model benchmark rows (${BENCHMARK_SOURCE})` });
  };
}

/**
 * Production seam: replace through a freshly-opened store (closed after the
 * write). Import-time inert (the `auto-evolve` pattern) — the unit suite never
 * touches the filesystem.
 */
const defaultDeps: BenchmarkIngestDeps = {
  replaceBenchmarks: (source, rows) => {
    const store = openStore(join(homedir(), ".vesper", "vesper.db"));
    try {
      return store.replaceModelBenchmarks(source, rows);
    } finally {
      store.close();
    }
  },
};

/** The default `benchmark-ingest` handler used by the static pipeline registry. */
export const benchmarkIngestHandler: TaskHandler = createBenchmarkIngestHandler(defaultDeps);

/**
 * Cron wiring: daily at 06:15 local, bounded. Declares exactly NETWORK_FETCH
 * (the allowlisted leaderboard fetch) + WRITE_STORAGE (snapshot + run row).
 */
export const benchmarkIngestTaskInput: RegisterTaskInput = {
  id: "benchmark-ingest",
  kind: "cron",
  schedule_expr: "15 6 * * *",
  handler_id: BENCHMARK_INGEST_HANDLER_ID,
  max_runs_per_day: 2,
  max_duration_ms: 60_000,
  required_capabilities: ["NETWORK_FETCH", "WRITE_STORAGE"],
};
