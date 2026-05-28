import type { Scheduler, Store } from "@vesper/core";
import { buildWorld } from "../world/build.ts";
import type { PipelineInfo, RunInfo, SceneGraph } from "../world/types.ts";

/** Build the current {@link SceneGraph} from live scheduler + storage state. Pure read. */
export function buildSnapshot(scheduler: Scheduler, store: Store, seed: string): SceneGraph {
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
  return buildWorld({ pipelines, runs, seed });
}
