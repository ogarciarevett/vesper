import { fnv1a, seededUnit } from "./hash.ts";
import type {
  AgentMood,
  Inhabitant,
  PresenceInfo,
  RunInfo,
  SceneGraph,
  WorldSnapshot,
} from "./types.ts";

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

/** Presence band: live external agents float in the upper part of the scene. */
const PRESENCE_BAND_TOP = 0.12;
const PRESENCE_BAND_HEIGHT = 0.28;

/**
 * Build the live-presence inhabitants — external agents (CLIs, desktop apps)
 * running on this machine right now. Positions are seeded by agent id (stable
 * per agent across polls, independent of how many are running), so a given agent
 * always floats in the same spot. These are visually distinct (`live: true`) and
 * carry no run history.
 */
function buildPresenceInhabitants(presences: readonly PresenceInfo[], seed: string): Inhabitant[] {
  return presences.map((pr): Inhabitant => {
    const x = clamp(
      EDGE_MARGIN + seededUnit(`${seed}:presence:${pr.id}:x`) * (1 - 2 * EDGE_MARGIN),
      EDGE_MARGIN,
      1 - EDGE_MARGIN,
    );
    const y = PRESENCE_BAND_TOP + seededUnit(`${seed}:presence:${pr.id}:y`) * PRESENCE_BAND_HEIGHT;
    return {
      id: `presence:${pr.id}`,
      label: pr.label,
      x,
      y,
      prominence: clamp(0.5 + (pr.procCount - 1) * 0.06, 0.5, 1),
      mood: "ok",
      avatarSeed: fnv1a(`${seed}::presence:${pr.id}`),
      enabled: true,
      runCount: 0,
      lastStatus: null,
      lastSummary: null,
      lastRunAt: null,
      live: true,
      liveSince: pr.since,
    };
  });
}

/**
 * Project a {@link WorldSnapshot} into a renderable {@link SceneGraph} — pure and
 * deterministic: the same snapshot + seed always yields byte-identical output, so
 * the world is stable per machine yet unique across machines.
 *
 * Layout: pipelines sit in a loose grid with per-agent seeded jitter (stable,
 * non-overlapping-ish); live external-agent presences (CLIs/apps running on this
 * machine, from `snapshot.presences`) float in an upper band as their own `live`
 * inhabitants. Prominence ∝ each pipeline's share of total runs (auto-evolve from
 * usage). Mood from the last run; `working` is never produced here (the client
 * applies it live).
 */
export function buildWorld(snapshot: WorldSnapshot): SceneGraph {
  const { pipelines, runs, seed } = snapshot;
  const presences = snapshot.presences ?? [];
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
      live: false,
      liveSince: null,
    };
  });

  const presenceInhabitants = buildPresenceInhabitants(presences, seed);

  return {
    seed,
    inhabitants: [...inhabitants, ...presenceInhabitants],
    totalRuns,
    // Live agents make the world feel alive even before Vesper has run anything.
    liveliness: clamp((totalRuns + presences.length * 2) / LIVELINESS_SATURATION, 0, 1),
  };
}
