// @vesper/core — model catalog + benchmark-driven selection (specs/orchestrator-home.md).
// Slice A ships the catalog types; the benchmark store + selectModel land in slice D.

export {
  BENCHMARK_ALLOWED_HOSTS,
  BENCHMARK_SOURCE,
  BENCHMARK_URL,
  parseLeaderboard,
} from "./benchmark.ts";
export {
  type DirectoryModel,
  type DirectoryProvider,
  fetchModelDirectory,
  MODEL_DIRECTORY_ALLOWED_HOSTS,
  MODEL_DIRECTORY_URL,
  parseModelDirectory,
} from "./directory.ts";
export {
  type ModelChoice,
  type SelectModelOptions,
  selectModel,
  type TaskDifficulty,
} from "./select.ts";
export {
  DEFAULT_MODEL_CATALOG,
  type ModelCatalogEntry,
  type ModelsConfig,
  type ModelTier,
} from "./types.ts";
