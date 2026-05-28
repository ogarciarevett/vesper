import { fnv1a, seededUnit } from "./hash.ts";
import type { AgentMood, Inhabitant, RunInfo, SceneGraph, WorldSnapshot } from "./types.ts";

/** Total runs at which the world reaches full "liveliness" (ambient detail saturates). */
const LIVELINESS_SATURATION = 20;
/** Smallest prominence an agent ever has, so idle agents are still clearly visible. */
const MIN_PROMINENCE = 0.35;
/** Keep inhabitants off the canvas edges (normalized margin). */
const EDGE_MARGIN = 0.08;
/** Max seeded jitter from a grid cell center (normalized). */
const JITTER = 0.06;

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/** Map a run status to a mood; unknown-but-present statuses read as a neutral success. */
function moodFromStatus(status: string): AgentMood {
  if (status === "error") return "error";
  if (status === "no_change") return "no_change";
  return "ok";
}

/** Latest run (by ts) for a pipeline, or null. */
function lastRunFor(runs: readonly RunInfo[], id: string): RunInfo | null {
  let latest: RunInfo | null = null;
  for (const r of runs) {
    if (r.pipeline !== id) continue;
    if (latest === null || r.ts >= latest.ts) latest = r;
  }
  return latest;
}

/**
 * Project a {@link WorldSnapshot} into a renderable {@link SceneGraph} — pure and
 * deterministic: the same snapshot + seed always yields byte-identical output, so
 * the world is stable per machine yet unique across machines.
 *
 * Layout: a loose grid with per-agent seeded jitter (stable, non-overlapping-ish).
 * Prominence ∝ each agent's share of total runs (auto-evolve from usage). Mood from
 * the last run; `working` is never produced here (the client applies it live).
 */
export function buildWorld(snapshot: WorldSnapshot): SceneGraph {
  const { pipelines, runs, seed } = snapshot;
  const n = pipelines.length;

  const runCounts = pipelines.map((p) =>
    runs.reduce((c, r) => c + (r.pipeline === p.id ? 1 : 0), 0),
  );
  const maxRuns = runCounts.reduce((m, c) => Math.max(m, c), 0);
  const totalRuns = runCounts.reduce((a, b) => a + b, 0);

  const cols = Math.max(1, Math.ceil(Math.sqrt(n)));
  const rows = Math.max(1, Math.ceil(n / cols));

  const inhabitants: Inhabitant[] = pipelines.map((p, i): Inhabitant => {
    const last = lastRunFor(runs, p.id);
    const runCount = runCounts[i] ?? 0;
    const prominence =
      maxRuns > 0 ? MIN_PROMINENCE + (1 - MIN_PROMINENCE) * (runCount / maxRuns) : MIN_PROMINENCE;

    const mood: AgentMood = !p.enabled || last === null ? "idle" : moodFromStatus(last.status);

    // Deterministic grid cell + seeded jitter from (seed, id).
    const col = i % cols;
    const row = Math.floor(i / cols);
    const cellX = (col + 0.5) / cols;
    const cellY = (row + 0.5) / rows;
    const jx = (seededUnit(`${seed}:${p.id}:x`) - 0.5) * 2 * JITTER;
    const jy = (seededUnit(`${seed}:${p.id}:y`) - 0.5) * 2 * JITTER;

    return {
      id: p.id,
      label: p.label,
      x: clamp(cellX + jx, EDGE_MARGIN, 1 - EDGE_MARGIN),
      y: clamp(cellY + jy, EDGE_MARGIN, 1 - EDGE_MARGIN),
      prominence,
      mood,
      avatarSeed: fnv1a(`${seed}::${p.id}`),
      enabled: p.enabled,
      runCount,
      lastStatus: last?.status ?? null,
      lastSummary: last?.summary ?? null,
      lastRunAt: last?.ts ?? null,
    };
  });

  return {
    seed,
    inhabitants,
    totalRuns,
    liveliness: clamp(totalRuns / LIVELINESS_SATURATION, 0, 1),
  };
}
