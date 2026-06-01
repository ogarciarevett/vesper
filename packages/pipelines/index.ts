/**
 * `@vesper/pipelines` — the registry of built-in Vesper pipelines.
 *
 * Each pipeline is described by a {@link PipelineDescriptor}: a handler, the id it
 * is registered under, and the manual/scheduled task wiring. The host calls
 * {@link registerPipelines} to install every descriptor into a scheduler so the
 * daemon's `HandlerRegistry` is no longer empty and `vesper schedule list` shows
 * the available pipelines.
 */

import {
  type Capability,
  type HandlerRegistry,
  type RegisterTaskInput,
  type Scheduler,
  SchedulerError,
  type TaskHandler,
} from "@vesper/core";
import {
  AUTO_EVOLVE_HANDLER_ID,
  autoEvolveHandler,
  autoEvolveTaskInput,
} from "./auto-evolve/handler.ts";
import {
  DEMO_WORKER_HANDLER_ID,
  demoWorkerHandler,
  ORCHESTRATOR_DEMO_HANDLER_ID,
  orchestratorDemoHandler,
  orchestratorDemoTaskInput,
} from "./orchestrator-demo/handler.ts";
import { SELFTEST_HANDLER_ID, selftestHandler, selftestTaskInput } from "./selftest/handler.ts";
import {
  SKILL_TRAIN_HANDLER_ID,
  skillTrainHandler,
  skillTrainTaskInput,
} from "./skill-train/handler.ts";

export {
  AUTO_EVOLVE_HANDLER_ID,
  autoEvolveHandler,
  autoEvolveTaskInput,
  DEMO_WORKER_HANDLER_ID,
  demoWorkerHandler,
  ORCHESTRATOR_DEMO_HANDLER_ID,
  orchestratorDemoHandler,
  orchestratorDemoTaskInput,
  SELFTEST_HANDLER_ID,
  SKILL_TRAIN_HANDLER_ID,
  selftestHandler,
  selftestTaskInput,
  skillTrainHandler,
  skillTrainTaskInput,
};

/**
 * Self-contained description of a built-in pipeline: a handler plus optional task
 * wiring. A descriptor with `taskInput` registers a runnable/scheduled task; one
 * WITHOUT (e.g. a spawn-only sub-agent worker) registers the handler only, so a
 * parent pipeline can `ctx.spawn` it by id without it appearing in `schedule list`.
 */
export interface PipelineDescriptor {
  readonly handlerId: string;
  readonly handler: TaskHandler;
  readonly taskInput?: RegisterTaskInput;
}

/** Every built-in Vesper pipeline. */
export const PIPELINES: readonly PipelineDescriptor[] = [
  {
    handlerId: SELFTEST_HANDLER_ID,
    handler: selftestHandler,
    taskInput: selftestTaskInput,
  },
  {
    handlerId: SKILL_TRAIN_HANDLER_ID,
    handler: skillTrainHandler,
    taskInput: skillTrainTaskInput,
  },
  {
    handlerId: ORCHESTRATOR_DEMO_HANDLER_ID,
    handler: orchestratorDemoHandler,
    taskInput: orchestratorDemoTaskInput,
  },
  // Self-reflection: a daily, OPT-IN (enabled:false) cron that reads the runtime's
  // own health, reflects via the user's CLI, and writes proposals to `events`. The
  // default declared set is proposal-only (no PROCESS_RUN) — it cannot shell out.
  {
    handlerId: AUTO_EVOLVE_HANDLER_ID,
    handler: autoEvolveHandler,
    taskInput: autoEvolveTaskInput,
  },
  // Spawn-only worker: registered as a handler so orchestrator-demo can `ctx.spawn`
  // it, but it has no task of its own (not shown in `schedule list`).
  {
    handlerId: DEMO_WORKER_HANDLER_ID,
    handler: demoWorkerHandler,
  },
];

/**
 * The exact set of capabilities the built-in pipelines need — the union of every
 * registered pipeline's `required_capabilities`. The host grants THIS instead of
 * the full capability set, so the scheduler's capability check stays meaningful
 * (deny-by-default): a task can never receive a capability no pipeline declared.
 */
export function grantedCapabilities(): Capability[] {
  const granted = new Set<Capability>();
  for (const descriptor of PIPELINES) {
    for (const capability of descriptor.taskInput?.required_capabilities ?? []) {
      granted.add(capability);
    }
  }
  return [...granted];
}

/**
 * Install every built-in pipeline into the given scheduler.
 *
 * For each descriptor: register the handler FIRST (so the scheduler can resolve
 * `handler_id`), then register the task. Idempotent — an already-registered task
 * surfaces `duplicate_task`, which is swallowed; any other {@link SchedulerError}
 * (e.g. `unknown_handler`, `invalid_cron`) is re-thrown.
 *
 * `scheduler.register()` writes each pipeline's per-task capability grant (equal to
 * its `required_capabilities`) — including on the swallowed `duplicate_task` path —
 * so a daemon restart backfills grants for tasks persisted before per-task grants
 * existed. No grant writing happens here; that would duplicate the ceiling check.
 */
export function registerPipelines(scheduler: Scheduler, registry: HandlerRegistry): void {
  for (const descriptor of PIPELINES) {
    registry.register(descriptor.handlerId, descriptor.handler);

    // Spawn-only descriptors (no taskInput) register the handler only.
    if (descriptor.taskInput === undefined) continue;

    try {
      scheduler.register(descriptor.taskInput);
    } catch (error: unknown) {
      if (error instanceof SchedulerError && error.reason === "duplicate_task") {
        continue;
      }
      throw error;
    }
  }
}
