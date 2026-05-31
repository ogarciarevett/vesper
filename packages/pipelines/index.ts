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
import { SELFTEST_HANDLER_ID, selftestHandler, selftestTaskInput } from "./selftest/handler.ts";
import {
  SKILL_TRAIN_HANDLER_ID,
  skillTrainHandler,
  skillTrainTaskInput,
} from "./skill-train/handler.ts";

export {
  SELFTEST_HANDLER_ID,
  SKILL_TRAIN_HANDLER_ID,
  selftestHandler,
  selftestTaskInput,
  skillTrainHandler,
  skillTrainTaskInput,
};

/** Self-contained description of a built-in pipeline: handler + task wiring. */
export interface PipelineDescriptor {
  readonly handlerId: string;
  readonly handler: TaskHandler;
  readonly taskInput: RegisterTaskInput;
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
    for (const capability of descriptor.taskInput.required_capabilities ?? []) {
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
