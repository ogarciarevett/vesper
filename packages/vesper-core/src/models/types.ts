/**
 * Model-catalog types (`specs/orchestrator-home.md`, slice A).
 *
 * A catalog maps a CANONICAL model id (the name the orchestrator and the benchmark
 * table speak) to the concrete way to invoke it: which CLI adapter serves it and the
 * exact value passed to that CLI's model flag. The catalog lives in the host config
 * (`models` block) with a built-in default; `selectModel` (slice D) chooses an entry
 * by cost + intelligence from the benchmark snapshot.
 */

/** Coarse cost/capability band used when picking a model for a task. */
export type ModelTier = "cheap" | "mid" | "frontier";

/** One invocable model: which adapter serves it and the flag value that selects it. */
export interface ModelCatalogEntry {
  /** CLI adapter name that serves this model (e.g. "claude", "codex", "gemini"). */
  readonly cli: string;
  /** Exact value passed to the CLI's model flag (e.g. "opus", "gpt-5.5"). */
  readonly flag: string;
  readonly tier: ModelTier;
  /** Benchmark-table `model` strings (DeepSWE naming) that map to this entry. */
  readonly benchmarkNames?: readonly string[];
}

/** The `models` config block: a default canonical id + the invocable catalog. */
export interface ModelsConfig {
  /** Canonical id used when benchmarks are stale/absent. Must be a catalog key. */
  readonly default?: string;
  /** Keyed by canonical model id. */
  readonly catalog: Readonly<Record<string, ModelCatalogEntry>>;
}

/**
 * Built-in catalog so model routing works out of the box. Flag values use each
 * CLI's own naming (claude accepts the haiku/sonnet/opus aliases); users override
 * or extend any entry via the `models.catalog` config block — config wins per key.
 * `benchmarkNames` use the DeepSWE leaderboard's dashed naming.
 */
export const DEFAULT_MODEL_CATALOG: Readonly<Record<string, ModelCatalogEntry>> = {
  "claude-haiku": {
    cli: "claude",
    flag: "haiku",
    tier: "cheap",
    benchmarkNames: ["claude-haiku-4-5"],
  },
  "claude-sonnet": {
    cli: "claude",
    flag: "sonnet",
    tier: "mid",
    benchmarkNames: ["claude-sonnet-4-6"],
  },
  "claude-opus": {
    cli: "claude",
    flag: "opus",
    tier: "frontier",
    benchmarkNames: ["claude-opus-4-8", "claude-opus-4-7"],
  },
  "gpt-mini": {
    cli: "codex",
    flag: "gpt-5.4-mini",
    tier: "cheap",
    benchmarkNames: ["gpt-5-4-mini"],
  },
  gpt: {
    cli: "codex",
    flag: "gpt-5.5",
    tier: "frontier",
    benchmarkNames: ["gpt-5-5", "gpt-5-4"],
  },
  "gemini-flash": {
    cli: "gemini",
    flag: "gemini-3.5-flash",
    tier: "mid",
    benchmarkNames: ["gemini-3-5-flash", "gemini-3-flash-preview"],
  },
};
