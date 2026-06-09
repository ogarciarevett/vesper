/**
 * DeepSWE leaderboard parsing (`specs/orchestrator-home.md`, slice D).
 *
 * The ONLY trusted benchmark source for now is
 * `https://deepswe.datacurve.ai/artifacts/leaderboard-live.json` (Omar's call —
 * other leaderboards are not trusted). This module turns that untrusted JSON into
 * typed {@link ModelBenchmarkInput} rows with hand-rolled guards (repo convention,
 * no schema dependency); a malformed row is SKIPPED, never fatal.
 */

import type { ModelBenchmarkInput } from "../storage/types.ts";

/** The single trusted source id rows are stored under. */
export const BENCHMARK_SOURCE = "deepswe";

/** The exact artifact URL the ingest pipeline fetches. */
export const BENCHMARK_URL = "https://deepswe.datacurve.ai/artifacts/leaderboard-live.json";

/** The only host the ingest pipeline is ever allowed to reach. */
export const BENCHMARK_ALLOWED_HOSTS: readonly string[] = ["deepswe.datacurve.ai"];

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function numOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function strOrNull(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

/** Parse one leaderboard row; undefined when it lacks the required `model`. */
function parseRow(raw: unknown, generatedAt: string | null): ModelBenchmarkInput | undefined {
  if (!isRecord(raw)) return undefined;
  const model = strOrNull(raw.model);
  if (model === null) return undefined;
  return {
    generatedAt,
    model,
    harness: strOrNull(raw.harness),
    reasoningEffort: strOrNull(raw.reasoning_effort),
    config: strOrNull(raw.config),
    passRate: numOrNull(raw.pass_rate),
    passAt1: numOrNull(raw.pass_at_1),
    meanCostUsd: numOrNull(raw.mean_cost_usd),
    medianCostUsd: numOrNull(raw.median_cost_usd),
    meanInputTokens: numOrNull(raw.mean_input_tokens),
    meanOutputTokens: numOrNull(raw.mean_output_tokens),
    meanDurationSeconds: numOrNull(raw.mean_duration_seconds),
    rawJson: JSON.stringify(raw),
  };
}

/**
 * Parse the leaderboard document. Returns the well-formed rows (malformed ones
 * are dropped); an entirely malformed document yields an empty array.
 */
export function parseLeaderboard(json: unknown): ModelBenchmarkInput[] {
  if (!isRecord(json) || !Array.isArray(json.rows)) return [];
  const generatedAt = strOrNull(json.generated_at);
  const rows: ModelBenchmarkInput[] = [];
  for (const raw of json.rows) {
    const row = parseRow(raw, generatedAt);
    if (row !== undefined) rows.push(row);
  }
  return rows;
}
