/**
 * Registration of user-authored pipelines (specs/pipeline-editor.md): each ACTIVE
 * `custom_pipelines` row becomes a manual task `custom:<id>` whose handler is the
 * shared interpreter bound to that id. The handler id EQUALS the task id so the
 * per-task grant — keyed by handler_id — stays per-pipeline (one doc's capability
 * set never bleeds into another's).
 *
 * Save = refresh (unregister + register, so a changed doc updates the grant);
 * archive = unregister. The doc itself is read fresh from the store on every run,
 * so prompt-only edits apply without re-registration.
 */

import {
  type Capability,
  type HandlerRegistry,
  type Scheduler,
  SchedulerError,
} from "@vesper/core";
import { deriveCapabilities, parsePipelineDoc } from "./doc.ts";
import { type CustomPipelineDeps, createCustomPipelineHandler, customTaskId } from "./handler.ts";

/** A minimal projection of a `custom_pipelines` store row (avoids a core type dep). */
export interface CustomPipelineSource {
  readonly id: string;
  readonly doc: Record<string, unknown>;
}

/** Per-row outcome of a registration sweep (invalid docs are skipped, not fatal). */
export interface RegisterCustomPipelineResult {
  readonly id: string;
  readonly taskId: string;
  readonly ok: boolean;
  readonly capabilities: readonly Capability[];
  readonly errors: readonly string[];
}

/**
 * Register (or refresh) ONE custom pipeline. An existing task is unregistered
 * first so a changed doc rewrites the task's `required_capabilities` + grant.
 */
export function registerCustomPipeline(
  scheduler: Scheduler,
  registry: HandlerRegistry,
  source: CustomPipelineSource,
  deps: CustomPipelineDeps,
): RegisterCustomPipelineResult {
  const taskId = customTaskId(source.id);
  const parsed = parsePipelineDoc(source.doc, deps.contracts);
  if (!parsed.ok) {
    return { id: source.id, taskId, ok: false, capabilities: [], errors: parsed.errors };
  }
  const capabilities = deriveCapabilities(parsed.doc, deps.contracts);

  registry.register(taskId, createCustomPipelineHandler(source.id, deps));
  scheduler.unregister(taskId);
  try {
    scheduler.register({
      id: taskId,
      kind: "manual",
      schedule_expr: "",
      handler_id: taskId,
      enabled: true,
      required_capabilities: capabilities,
    });
  } catch (error: unknown) {
    if (error instanceof SchedulerError) {
      return { id: source.id, taskId, ok: false, capabilities, errors: [error.message] };
    }
    throw error;
  }
  return { id: source.id, taskId, ok: true, capabilities, errors: [] };
}

/** Unregister an archived custom pipeline's task (no-op when absent). */
export function unregisterCustomPipeline(scheduler: Scheduler, pipelineId: string): void {
  scheduler.unregister(customTaskId(pipelineId));
}

/**
 * Boot-time sweep: register every active row. Invalid rows are returned (not
 * thrown) so one bad doc never blocks the daemon — the editor surfaces the errors.
 */
export function registerCustomPipelines(
  scheduler: Scheduler,
  registry: HandlerRegistry,
  sources: readonly CustomPipelineSource[],
  deps: CustomPipelineDeps,
): RegisterCustomPipelineResult[] {
  return sources.map((source) => registerCustomPipeline(scheduler, registry, source, deps));
}
