import type { Scheduler, Store } from "@vesper/core";
import { buildWorld } from "../world/build.ts";
import type { PipelineInfo, PresenceInfo, RunInfo, SceneGraph } from "../world/types.ts";

/**
 * Build the current {@link SceneGraph} from live scheduler + storage state, plus
 * the agents currently running on this machine. Pure read — `presences` are
 * detected by the caller (the server's poll loop) and passed in so this stays
 * deterministic and free of process I/O.
 */
export function buildSnapshot(
  scheduler: Scheduler,
  store: Store,
  seed: string,
  presences: readonly PresenceInfo[] = [],
): SceneGraph {
  const pipelines: PipelineInfo[] = scheduler.list().map((t) => ({
    id: t.id,
    label: t.id,
    enabled: t.enabled,
    kind: t.kind,
  }));
  const runs: RunInfo[] = store.listRuns().map((r) => ({
    pipeline: r.pipeline,
    status: r.status,
    summary: r.summary,
    ts: r.ts,
  }));
  return buildWorld({ pipelines, runs, seed, presences });
}
