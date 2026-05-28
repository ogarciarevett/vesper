/** Public types for the World model — a deterministic, data-driven projection of
 * Vesper's pipelines + runs into a renderable scene. Pure: no DOM, no Canvas. */

/** A registered pipeline, as the world needs it. */
export interface PipelineInfo {
  readonly id: string;
  readonly label: string;
  readonly enabled: boolean;
  readonly kind: string;
}

/** A recorded run row, as the world needs it. */
export interface RunInfo {
  readonly pipeline: string;
  readonly status: string;
  readonly summary: string;
  /** Unix ms. */
  readonly ts: number;
}

/** Everything `buildWorld` needs: the registered pipelines, their runs, and a machine seed. */
export interface WorldSnapshot {
  readonly pipelines: readonly PipelineInfo[];
  readonly runs: readonly RunInfo[];
  /** Stable per-machine seed (fingerprint) — makes the world deterministic + unique. */
  readonly seed: string;
}

/**
 * An agent's visible mood. `idle` = never run / disabled; `ok`/`no_change`/`error`
 * come from the last run's status; `working` is a transient state the CLIENT applies
 * on a live `run:started`/optimistic action (never produced by `buildWorld`).
 */
export type AgentMood = "idle" | "ok" | "no_change" | "error" | "working";

/** One inhabitant of the world (an agent / pipeline), positioned + styled. */
export interface Inhabitant {
  readonly id: string;
  readonly label: string;
  /** Normalized position in [0,1] x [0,1]; the renderer maps to canvas pixels. */
  readonly x: number;
  readonly y: number;
  /** [0,1] — how prominent the agent is, proportional to its share of runs. */
  readonly prominence: number;
  readonly mood: AgentMood;
  /** Deterministic per-agent seed for sprite generation (>= 0). */
  readonly avatarSeed: number;
  readonly enabled: boolean;
  readonly runCount: number;
  readonly lastStatus: string | null;
  readonly lastSummary: string | null;
  readonly lastRunAt: number | null;
}

/** The renderable scene: the inhabitants + world-level aggregates. */
export interface SceneGraph {
  readonly seed: string;
  readonly inhabitants: readonly Inhabitant[];
  readonly totalRuns: number;
  /** [0,1] — overall "liveliness" of the world (scales ambient detail), from total activity. */
  readonly liveliness: number;
}
