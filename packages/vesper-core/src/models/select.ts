/**
 * Benchmark-driven model selection (`specs/orchestrator-home.md`, slice D).
 *
 * Pure: joins the persisted benchmark snapshot to the model catalog (via each
 * entry's `benchmarkNames`) and picks an invocable model for a task difficulty.
 * Selection must NEVER kill a run — stale/missing data falls back to the
 * configured default entry, and ultimately to `undefined` (no model flag at all,
 * i.e. exactly today's behavior).
 */

import type { ModelBenchmarkRow } from "../storage/types.ts";
import type { ModelCatalogEntry, ModelsConfig } from "./types.ts";

/** Coarse difficulty of the task a model is being picked for. */
export type TaskDifficulty = "easy" | "medium" | "hard";

/** The selector's pick: an invocable (cli, flag) pair plus the why. */
export interface ModelChoice {
  readonly canonicalId: string;
  readonly cli: string;
  readonly flag: string;
  readonly reason: string;
}

/** Options for {@link selectModel}. */
export interface SelectModelOptions {
  /** Snapshot age beyond which benchmarks are ignored (default 7 days). */
  readonly staleAfterMs?: number;
  /** Clock injection for tests. */
  readonly now?: number;
}

const DEFAULT_STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1_000;

/** An entry joined to its best benchmark row. */
interface ScoredEntry {
  readonly canonicalId: string;
  readonly entry: ModelCatalogEntry;
  readonly passAt1: number;
  readonly meanCostUsd: number | null;
}

function fallback(catalog: ModelsConfig, reason: string): ModelChoice | undefined {
  const id = catalog.default;
  if (id === undefined) return undefined;
  const entry = catalog.catalog[id];
  if (entry === undefined) return undefined;
  return { canonicalId: id, cli: entry.cli, flag: entry.flag, reason };
}

/** Join each catalog entry to its best (highest pass@1) fresh benchmark row. */
function scoreEntries(
  benchmarks: readonly ModelBenchmarkRow[],
  catalog: ModelsConfig,
): ScoredEntry[] {
  const scored: ScoredEntry[] = [];
  for (const [canonicalId, entry] of Object.entries(catalog.catalog)) {
    const names = new Set(entry.benchmarkNames ?? []);
    if (names.size === 0) continue;
    let best: ModelBenchmarkRow | undefined;
    for (const row of benchmarks) {
      if (!names.has(row.model) || row.passAt1 === null) continue;
      if (best === undefined || (best.passAt1 ?? 0) < row.passAt1) best = row;
    }
    if (best?.passAt1 == null) continue;
    scored.push({ canonicalId, entry, passAt1: best.passAt1, meanCostUsd: best.meanCostUsd });
  }
  return scored;
}

/**
 * Pick a model for `difficulty`:
 * - `hard`   -> the highest pass@1.
 * - `easy`   -> the CHEAPEST entry whose pass@1 is >= 0.6x the best (good enough,
 *               priced for volume).
 * - `medium` -> the best pass@1 per dollar.
 *
 * Stale (older than `staleAfterMs`) or empty benchmarks -> the catalog default ->
 * `undefined`.
 */
export function selectModel(
  benchmarks: readonly ModelBenchmarkRow[],
  catalog: ModelsConfig,
  difficulty: TaskDifficulty,
  options: SelectModelOptions = {},
): ModelChoice | undefined {
  const staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  const now = options.now ?? Date.now();

  const fresh = benchmarks.filter((row) => now - row.fetchedAt <= staleAfterMs);
  if (fresh.length === 0) {
    return fallback(catalog, "no fresh benchmark data — configured default");
  }
  const scored = scoreEntries(fresh, catalog);
  if (scored.length === 0) {
    return fallback(catalog, "no catalog entry matches the benchmark rows — configured default");
  }

  const best = scored.reduce((a, b) => (b.passAt1 > a.passAt1 ? b : a));
  let pick: ScoredEntry;
  let why: string;

  if (difficulty === "hard") {
    pick = best;
    why = `best pass@1 ${(pick.passAt1 * 100).toFixed(1)}%`;
  } else if (difficulty === "easy") {
    const eligible = scored.filter((s) => s.passAt1 >= 0.6 * best.passAt1);
    const priced = eligible.filter((s) => s.meanCostUsd !== null);
    pick = (priced.length > 0 ? priced : eligible).reduce((a, b) =>
      (b.meanCostUsd ?? Number.POSITIVE_INFINITY) < (a.meanCostUsd ?? Number.POSITIVE_INFINITY)
        ? b
        : a,
    );
    why = `cheapest within 0.6x of best (pass@1 ${(pick.passAt1 * 100).toFixed(1)}%)`;
  } else {
    const valued = scored.filter((s) => s.meanCostUsd !== null && s.meanCostUsd > 0);
    pick =
      valued.length > 0
        ? valued.reduce((a, b) =>
            b.passAt1 / (b.meanCostUsd as number) > a.passAt1 / (a.meanCostUsd as number) ? b : a,
          )
        : best;
    why = `best pass@1 per dollar (pass@1 ${(pick.passAt1 * 100).toFixed(1)}%)`;
  }

  return {
    canonicalId: pick.canonicalId,
    cli: pick.entry.cli,
    flag: pick.entry.flag,
    reason: why,
  };
}
