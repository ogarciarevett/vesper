/**
 * In-process sub-agent execution. A handler calls `ctx.spawn(descriptor)`; the
 * scheduler wires that to {@link runSubAgent}, which:
 *
 * - enforces the TWO-SIDED capability gate (descriptor caps must be a subset of
 *   the parent task's grant AND of the host ceiling),
 * - enforces depth = 1 (a sub-agent cannot spawn sub-agents) and an optional
 *   per-parent fan-out cap,
 * - allocates the child `runs` row up front (status `running`) so the live tree
 *   shows the sub-agent before it finishes,
 * - runs the registered child handler in-process (no new daemon, no scheduled
 *   task, no dynamic eval) under an inherited duration budget,
 * - finalizes the child row and emits live-trace events on the parent.
 *
 * The gates + row allocation run synchronously so `ctx.spawn` throws on refusal;
 * the handler itself runs inside the returned handle's `done` promise.
 */

import { assertCapabilities } from "../capabilities/assert.ts";
import type { Capability } from "../capabilities/index.ts";
import type { Store } from "../storage/types.ts";
import { buildPipelineContext } from "./context.ts";
import { SchedulerError } from "./errors.ts";
import type { EventBus } from "./events.ts";
import { RUN_EVENT } from "./events.ts";
import type { HandlerRegistry } from "./registry.ts";
import { remainingBudgetMs, withTimeout } from "./timeout.ts";
import type {
  CompleteFn,
  NotifyFn,
  PipelineContext,
  RunOutcome,
  ScheduledTask,
  SubAgentDescriptor,
  SubAgentHandle,
} from "./types.ts";

/** Arguments for {@link runSubAgent}. */
export interface RunSubAgentArgs {
  readonly descriptor: SubAgentDescriptor;
  /** The parent context that called `spawn`. */
  readonly parent: PipelineContext;
  readonly store: Store;
  readonly events: EventBus;
  readonly registry: HandlerRegistry;
  /** Host capability ceiling — the absolute upper bound. */
  readonly grants: readonly Capability[];
  /** Parent task's grant — descriptor caps must be a subset of this. */
  readonly parentTaskCapabilities: readonly Capability[];
  readonly complete?: CompleteFn;
  readonly notify?: NotifyFn;
  readonly redactSummaries: boolean;
  /** Time the parent still has before ITS cap fires; null = unbounded. */
  readonly parentRemainingMs: number | null;
  /** Spawn depth of the CHILD being created (0 = first-level child). */
  readonly depth: number;
  readonly maxFanout: number;
  /** Returns the number of children already spawned by this parent. */
  readonly childCount: () => number;
}

/**
 * Spawn a single sub-agent. Throws synchronously (before returning a handle) on a
 * capability/depth/fan-out refusal or an unknown handler; otherwise returns a
 * {@link SubAgentHandle} whose `done` resolves with the child {@link RunOutcome}.
 */
export function runSubAgent(args: RunSubAgentArgs): SubAgentHandle {
  const {
    descriptor,
    parent,
    store,
    events,
    registry,
    grants,
    parentTaskCapabilities,
    complete,
    notify,
    redactSummaries,
    parentRemainingMs,
    depth,
    maxFanout,
    childCount,
  } = args;

  const descriptorCaps = descriptor.capabilities ?? [];

  // (1) Two-sided capability gate (both throw CapabilityError "denied").
  // Parent grant first so a descriptor exceeding the parent is attributed to it.
  assertCapabilities(descriptorCaps, parentTaskCapabilities);
  assertCapabilities(descriptorCaps, grants);

  // (2) Depth guard — sub-agents cannot spawn sub-agents.
  if (depth >= 1) {
    throw new SchedulerError(
      "subagent_depth",
      `sub-agent "${descriptor.label}" cannot spawn further sub-agents (depth limit 1)`,
    );
  }

  // (3) Fan-out guard.
  if (childCount() >= maxFanout) {
    throw new SchedulerError(
      "fanout_exceeded",
      `parent run "${parent.runId}" has reached its sub-agent fan-out cap (${maxFanout})`,
    );
  }

  // (4) Resolve the registered handler (throws unknown_handler — no eval).
  const handler = registry.get(descriptor.handlerId);

  // (5) Allocate the child row up front so the live tree shows it immediately.
  const childRunId = store.startRun({
    pipeline: descriptor.handlerId,
    parentRunId: parent.runId,
  });

  // (6) Emit a 'spawn' live-trace step on the PARENT (persist + publish). The
  // persisted row's id + ts ride the bus payload so a live frame de-dupes against
  // its backfilled twin (same id) instead of colliding on an 'undefined' id.
  const spawnEventId = store.appendRunEvent({
    runId: parent.runId,
    kind: "spawn",
    payload: { message: descriptor.label, data: { childRunId } },
  });
  events.emit(RUN_EVENT, {
    id: spawnEventId,
    ts: Date.now(),
    runId: parent.runId,
    parentRunId: parent.parentRunId,
    kind: "spawn",
    message: descriptor.label,
    data: { childRunId },
  });

  // (7) Build the child context. A synthetic child task carries exactly the
  // descriptor caps so the child's own complete/recordRun/emitProgress gates are
  // correct. The child's `spawn` is injected to ALWAYS throw subagent_depth.
  const childTask: ScheduledTask = {
    ...parent.task,
    id: descriptor.handlerId,
    handler_id: descriptor.handlerId,
    required_capabilities: descriptorCaps,
  };

  const recordedRef: { current: { runId: string; status: string; summary: string } | null } = {
    current: null,
  };
  let rowFinalized = false;

  const childCtx = buildPipelineContext({
    task: childTask,
    now: parent.now,
    runId: childRunId,
    parentRunId: parent.runId,
    store,
    events,
    grants,
    parentTaskCapabilities: descriptorCaps,
    maxFanout,
    ...(complete !== undefined ? { complete } : {}),
    ...(notify !== undefined ? { notify } : {}),
    // Thread the descriptor's params through to the child's `ctx.params`, so a
    // parent can parameterize each sub-agent it fans out.
    ...(descriptor.params !== undefined ? { options: { params: descriptor.params } } : {}),
    redactSummaries,
    onRecordRun: (record) => {
      recordedRef.current = record;
      rowFinalized = true;
    },
    // Injected spawn that refuses: depth-1 children cannot spawn grandchildren.
    spawn: () => {
      throw new SchedulerError(
        "subagent_depth",
        `sub-agent "${descriptor.label}" cannot spawn further sub-agents (depth limit 1)`,
      );
    },
  });

  // (8) Child duration budget = min(descriptor cap, parent remaining).
  const childTimeout = remainingBudgetMs(descriptor.maxDurationMs ?? null, parentRemainingMs);

  // (9) Run the handler in the background; `done` resolves with the outcome.
  const done: Promise<RunOutcome> = (async () => {
    const startedAt = performance.now();
    try {
      await withTimeout(
        () => handler(childCtx),
        childTimeout,
        `sub-agent "${descriptor.label}" exceeded duration`,
      );
      const durationMs = Math.round(performance.now() - startedAt);

      // If the handler recorded a run, ctx.recordRun already finished the row.
      // Otherwise the scheduler-style finalize transitions it to a terminal 'ok'.
      const final = recordedRef.current;
      if (final === null) {
        store.finishRun({ runId: childRunId, status: "ok", summary: "" });
        rowFinalized = true;
      }

      const outcome: RunOutcome = {
        taskId: descriptor.handlerId,
        runId: childRunId,
        status: final?.status ?? "ok",
        summary: final?.summary ?? "",
        cli: null,
        durationMs,
      };

      emitComplete(
        store,
        events,
        childRunId,
        parent.runId,
        descriptor.label,
        outcome.status ?? "ok",
      );
      return outcome;
    } catch (cause) {
      const errorMsg = cause instanceof Error ? cause.message : String(cause);
      // Don't clobber a status the handler already committed via recordRun.
      if (!rowFinalized) {
        store.finishRun({ runId: childRunId, status: "error", summary: errorMsg });
      }
      emitComplete(store, events, childRunId, parent.runId, descriptor.label, "error");
      throw cause;
    }
  })();

  return { runId: childRunId, handlerId: descriptor.handlerId, label: descriptor.label, done };
}

/**
 * Emit a 'complete' live-trace event for a finished child. NOT a RUN_COMPLETED —
 * that topic stays top-level-only so the UI does not double-count children as
 * top-level run pops.
 */
function emitComplete(
  store: Store,
  events: EventBus,
  childRunId: string,
  parentRunId: string,
  label: string,
  status: string,
): void {
  // Persist the 'complete' step (so it replays on reconnect) and ride its id + ts
  // on the bus payload, matching the spawn/progress frames.
  const id = store.appendRunEvent({
    runId: childRunId,
    kind: "complete",
    payload: { message: label, data: { status } },
  });
  events.emit(RUN_EVENT, {
    id,
    ts: Date.now(),
    runId: childRunId,
    parentRunId,
    kind: "complete",
    message: label,
    data: { status },
  });
}
