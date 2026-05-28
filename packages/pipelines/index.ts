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
  type HandlerRegistry,
  type RegisterTaskInput,
  type Scheduler,
  SchedulerError,
  type TaskHandler,
} from "@vesper/core";
import { ECHO_HANDLER_ID, echoHandler, echoTaskInput } from "./echo/handler.ts";

export { ECHO_HANDLER_ID, echoHandler, echoTaskInput };

/** Self-contained description of a built-in pipeline: handler + task wiring. */
export interface PipelineDescriptor {
  readonly handlerId: string;
  readonly handler: TaskHandler;
  readonly taskInput: RegisterTaskInput;
}

/** Every built-in Vesper pipeline. */
export const PIPELINES: readonly PipelineDescriptor[] = [
  {
    handlerId: ECHO_HANDLER_ID,
    handler: echoHandler,
    taskInput: echoTaskInput,
  },
];

/**
 * Install every built-in pipeline into the given scheduler.
 *
 * For each descriptor: register the handler FIRST (so the scheduler can resolve
 * `handler_id`), then register the task. Idempotent — an already-registered task
 * surfaces `duplicate_task`, which is swallowed; any other {@link SchedulerError}
 * (e.g. `unknown_handler`, `invalid_cron`) is re-thrown.
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
