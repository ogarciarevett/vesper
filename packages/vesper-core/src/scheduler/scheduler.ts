import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { assertCapabilities, isGranted } from "../capabilities/assert.ts";
import { CapabilityError } from "../capabilities/errors.ts";
import type { Capability } from "../capabilities/index.ts";
import { SqliteStore } from "../storage/store.ts";
import type { Store } from "../storage/types.ts";
import { buildPipelineContext } from "./context.ts";
import { cronMatches, parseCron } from "./cron.ts";
import { SchedulerError } from "./errors.ts";
import { EventBus, RUN_COMPLETED } from "./events.ts";
import { TaskPersistence } from "./persistence.ts";
import type { HandlerRegistry } from "./registry.ts";
import { runSubAgent } from "./subagent.ts";
import { withTimeout } from "./timeout.ts";
import type {
  CompleteFn,
  PipelineContext,
  RegisterTaskInput,
  RunOptions,
  RunOutcome,
  ScheduledTask,
  SubAgentDescriptor,
  SubAgentHandle,
} from "./types.ts";

/** Mutable sink the success path of `#invoke` fills so `run()` can return a {@link RunOutcome}. */
interface OutcomeCapture {
  outcome?: RunOutcome;
}

/** Options for constructing a {@link Scheduler}. */
export interface SchedulerOptions {
  readonly db: Database;
  readonly registry: HandlerRegistry;
  /** Returns the current time. Defaults to `() => new Date()`. Inject for tests. */
  readonly clock?: () => Date;
  /** Event bus for "event" kind tasks. If omitted, a new one is created internally. */
  readonly events?: EventBus;
  /**
   * Capabilities the host grants to tasks.
   * Defaults to [] (no capabilities granted).
   * Tasks with required_capabilities not covered by this list will be refused.
   */
  readonly grants?: readonly Capability[];
  /**
   * Resolver used by `ctx.complete` to shell out to a CLI adapter. Injected by
   * the host (CLI layer). If omitted, handlers that call `ctx.complete` fail with
   * a clear {@link import("../cli/errors.ts").CLIError}.
   */
  readonly complete?: CompleteFn;
  /**
   * When true, run summaries are persisted as size-only metadata (raw CLI output
   * is never stored in cleartext). Host policy from `~/.vesper/config.json`.
   */
  readonly redactSummaries?: boolean;
  /**
   * Maximum number of sub-agents a single parent run may spawn. Defaults to 8.
   * Clamped to a minimum of 1. The (cap+1)th `ctx.spawn` throws
   * `SchedulerError("fanout_exceeded")`.
   */
  readonly maxFanout?: number;
}

// ---------------------------------------------------------------------------
// Guardrail constants
// ---------------------------------------------------------------------------

/** Base backoff delay in milliseconds (1 second). */
const BACKOFF_BASE_MS = 1_000;
/** Maximum backoff delay cap (1 hour). */
const BACKOFF_MAX_MS = 3_600_000;
/** Number of consecutive failures before a task is dead-lettered and disabled. */
const MAX_ATTEMPTS = 5;

/** Default cap on the number of sub-agents a single parent run may spawn. */
const DEFAULT_MAX_FANOUT = 8;

/**
 * Compute exponential backoff delay for attempt number `attempt` (1-based).
 * Returns `base * 2^(attempt - 1)`, capped at `BACKOFF_MAX_MS`.
 */
function backoffDelayMs(attempt: number): number {
  const raw = BACKOFF_BASE_MS * 2 ** (attempt - 1);
  return Math.min(raw, BACKOFF_MAX_MS);
}

/** Format a Date as a YYYY-MM-DD string (local time). */
function toDateString(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * Core scheduler: registers tasks (cron, event, manual), persists them, and
 * drives execution via `tick()` (cron) or event subscriptions.
 *
 * - Tasks are loaded from the database on construction (survives restarts).
 * - The injected clock drives `tick()` so tests never wait on real time.
 * - Handlers are resolved by string ID from the {@link HandlerRegistry} —
 *   no dynamic evaluation.
 */
export class Scheduler {
  readonly #persistence: TaskPersistence;
  readonly #registry: HandlerRegistry;
  readonly #clock: () => Date;
  readonly #events: EventBus;
  readonly #grants: readonly Capability[];
  readonly #store: Store;
  readonly #complete: CompleteFn | undefined;
  readonly #redactSummaries: boolean;
  readonly #maxFanout: number;

  /**
   * Per-parent-run sub-agent counter, keyed by the top-level run id. Drives the
   * fan-out cap; entries are short-lived (one parent invocation).
   */
  readonly #childCounts: Map<string, number> = new Map();

  /**
   * Map of task id -> bound event listener, so event tasks can be cleanly
   * unsubscribed when unregistered.
   */
  readonly #eventListeners: Map<string, (payload?: unknown) => void> = new Map();

  /**
   * In-memory per-task in-flight counter for max_concurrent enforcement.
   * Keys are task ids; values are the current number of active invocations.
   */
  readonly #inFlight: Map<string, number> = new Map();

  constructor(options: SchedulerOptions) {
    this.#persistence = new TaskPersistence(options.db);
    this.#registry = options.registry;
    this.#clock = options.clock ?? (() => new Date());
    this.#events = options.events ?? new EventBus();
    this.#grants = options.grants ?? [];
    this.#store = new SqliteStore(options.db);
    this.#complete = options.complete;
    this.#redactSummaries = options.redactSummaries ?? false;
    this.#maxFanout = Math.max(1, options.maxFanout ?? DEFAULT_MAX_FANOUT);

    // Load all persisted tasks and wire up event subscriptions.
    const tasks = this.#persistence.list();
    for (const task of tasks) {
      if (task.kind === "event" && task.enabled) {
        this.#subscribeEvent(task);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Registration
  // ---------------------------------------------------------------------------

  /**
   * Register a new task.
   *
   * - Enforces the capability CEILING: `required_capabilities` must be a subset
   *   of the host union (`grants`); otherwise nothing is persisted.
   * - Validates the cron expression for `kind = "cron"` tasks.
   * - Persists the task and writes its per-task capability grant (the grant equals
   *   the declared `required_capabilities`).
   * - Subscribes the handler to the event bus for `kind = "event"` tasks.
   *
   * The grant is upserted even when the task already exists (the daemon-restart
   * path through `registerPipelines`), so an already-persisted built-in task that
   * predates per-task grants gets its grant backfilled before `duplicate_task` is
   * surfaced — without a grant the task would be silently denied at run time.
   *
   * Throws:
   * - `SchedulerError("unknown_handler")` if `handler_id` is not in the registry.
   * - `SchedulerError("grant_exceeds_ceiling")` if a required capability is not in
   *   the host union (persists nothing — no task row, no grant row).
   * - `SchedulerError("invalid_cron")` if `kind = "cron"` and the expression is invalid.
   * - `SchedulerError("duplicate_task")` if `input.id` is already registered (the
   *   grant is still backfilled before this throw).
   */
  register(input: RegisterTaskInput): ScheduledTask {
    // Verify the handler exists before persisting.
    this.#registry.get(input.handler_id);

    const required = input.required_capabilities ?? [];

    // Capability CEILING: a grant can never exceed the host union. Checked BEFORE
    // any persistence so a ceiling failure leaves no task row and no grant row.
    if (required.length > 0 && !isGranted(required, this.#grants)) {
      const exceeded = required.filter((cap) => !this.#grants.includes(cap));
      throw new SchedulerError(
        "grant_exceeds_ceiling",
        `task "${input.id}" requires capabilities outside the host grant ceiling: ${exceeded.join(", ")}`,
      );
    }

    // Duplicate check. Even when the task already exists we backfill its grant
    // (idempotent upsert) so a daemon restart against a pre-grant DB does not
    // leave built-in tasks ungranted and therefore silently denied.
    const existing = this.#persistence.get(input.id);
    if (existing !== null) {
      this.#store.upsertTaskGrant({
        handler_id: input.handler_id,
        capabilities: required,
        granted_by: "register",
      });
      throw new SchedulerError("duplicate_task", `task "${input.id}" is already registered`);
    }

    // Validate cron expression early.
    if (input.kind === "cron") {
      parseCron(input.schedule_expr);
    }

    const task: ScheduledTask = {
      id: input.id,
      kind: input.kind,
      schedule_expr: input.schedule_expr,
      handler_id: input.handler_id,
      enabled: input.enabled !== undefined ? input.enabled : true,
      last_run_at: null,
      last_error: null,
      max_runs_per_day: input.max_runs_per_day ?? null,
      max_concurrent: input.max_concurrent ?? null,
      max_duration_ms: input.max_duration_ms ?? null,
      runs_today: 0,
      runs_today_date: null,
      attempt_count: 0,
      next_attempt_at: null,
      required_capabilities: required,
    };

    this.#persistence.insert(task);

    // Write the per-task grant atomically with the task. The grant equals the
    // declared required_capabilities (built-in parity); enforcement reads THIS,
    // not the host union, so a task can be denied a capability another task holds.
    this.#store.upsertTaskGrant({
      handler_id: input.handler_id,
      capabilities: required,
      granted_by: "register",
    });

    // Wire up event subscription after successful persist.
    if (task.kind === "event" && task.enabled) {
      this.#subscribeEvent(task);
    }

    return task;
  }

  /**
   * Unregister a task by id.
   *
   * Removes the event subscription if applicable and deletes the row.
   * No-op if `id` does not exist.
   */
  unregister(id: string): void {
    const task = this.#persistence.get(id);
    if (task === null) return;

    if (task.kind === "event") {
      this.#unsubscribeEvent(id);
    }

    this.#persistence.delete(id);
  }

  // ---------------------------------------------------------------------------
  // Query
  // ---------------------------------------------------------------------------

  /** Return all registered tasks. */
  list(): ScheduledTask[] {
    return this.#persistence.list();
  }

  // ---------------------------------------------------------------------------
  // Manual execution
  // ---------------------------------------------------------------------------

  /**
   * Run a task on demand, regardless of its kind or schedule.
   *
   * Records the run result (timestamp + error if any) in the database.
   * Guardrail caps (max_runs_per_day, max_concurrent, max_duration_ms) are
   * honored for manual runs: the timeout still applies; daily cap and concurrent
   * limit are checked and respected, but a blocked manual run throws rather than
   * silently skipping.
   *
   * Pass `options` to supply a per-run CLI override and transient params; these
   * are surfaced to the handler via `ctx` and never persisted on the task.
   *
   * Returns a {@link RunOutcome} describing the completed run (status/summary the
   * handler recorded, the run id, the per-run CLI, and the wall-clock duration).
   * Throws `SchedulerError("unknown_task")` if `id` is not registered, and
   * propagates handler errors (CLIError/CapabilityError/...) to the caller.
   */
  async run(id: string, options?: RunOptions): Promise<RunOutcome> {
    const task = this.#persistence.get(id);
    if (task === null) {
      throw new SchedulerError("unknown_task", `task "${id}" is not registered`);
    }

    const capture: OutcomeCapture = {};
    await this.#invoke(task, false, options, capture);
    // A manual run either threw above or reached the handler success path (manual
    // guardrail skips throw rather than returning), so capture.outcome is set.
    return (
      capture.outcome ?? {
        taskId: id,
        runId: null,
        status: null,
        summary: null,
        cli: options?.cli ?? null,
        durationMs: 0,
      }
    );
  }

  // ---------------------------------------------------------------------------
  // Cron tick
  // ---------------------------------------------------------------------------

  /**
   * Evaluate all enabled cron tasks against `now` (defaults to `clock()`).
   *
   * Tasks whose schedule matches `now` to the minute are invoked.
   * Results (timestamp and any error) are recorded in the database.
   */
  async tick(now?: Date): Promise<void> {
    const currentTime = now ?? this.#clock();
    const tasks = this.#persistence.list();

    const cronTasks = tasks.filter((t) => t.kind === "cron" && t.enabled);

    for (const task of cronTasks) {
      let parsed: ReturnType<typeof parseCron> | undefined;
      try {
        parsed = parseCron(task.schedule_expr);
      } catch {
        // Invalid cron stored in DB — skip silently (the parse error was caught
        // at register time; this guards against manually corrupted rows).
        continue;
      }

      if (cronMatches(parsed, currentTime)) {
        try {
          await this.#invoke(task, true);
        } catch {
          // Per-task failure is already recorded in last_error; isolate it so one
          // bad task does not abort the others due in this tick.
        }
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Resolve and run a task's handler, recording last_run_at and last_error.
   *
   * When `isScheduled` is true (cron tick or event), all guardrail caps are enforced
   * and backoff/dead-letter logic applies. When false (manual run), caps are checked
   * but skip conditions cause the error to propagate (not silently skip).
   *
   * On any failure the original error is re-thrown after being recorded.
   */
  async #invoke(
    task: ScheduledTask,
    isScheduled: boolean,
    options?: RunOptions,
    capture?: OutcomeCapture,
  ): Promise<void> {
    const now = this.#clock();

    // Re-fetch from persistence so we always have up-to-date guardrail state.
    const current = this.#persistence.get(task.id) ?? task;

    // -- backoff gate (scheduled only) --
    if (
      isScheduled &&
      current.next_attempt_at !== null &&
      now.getTime() < current.next_attempt_at
    ) {
      // Task is in backoff; silently skip for scheduled runs.
      return;
    }

    // -- daily runs cap --
    if (current.max_runs_per_day !== null) {
      const todayStr = toDateString(now);
      const isNewDay = current.runs_today_date !== todayStr;
      const todayCount = isNewDay ? 0 : current.runs_today;

      if (todayCount >= current.max_runs_per_day) {
        if (isScheduled) {
          // Disable the task and record the reason.
          this.#persistence.updateGuardrails(current.id, {
            enabled: false,
            last_error: `max_runs_per_day cap (${current.max_runs_per_day}) reached for ${todayStr}`,
          });
          // Also update last_run_at so callers can see the timestamp.
          this.#persistence.updateLastRun(
            current.id,
            now.getTime(),
            `max_runs_per_day cap (${current.max_runs_per_day}) reached for ${todayStr}`,
          );
          return;
        }
        // For manual runs, throw so the caller knows the cap was hit.
        throw new SchedulerError(
          "cap_exceeded",
          `task "${current.id}" has reached its max_runs_per_day cap (${current.max_runs_per_day}) for ${todayStr}`,
        );
      }
    }

    // -- concurrent cap --
    if (current.max_concurrent !== null) {
      const inFlight = this.#inFlight.get(current.id) ?? 0;
      if (inFlight >= current.max_concurrent) {
        if (isScheduled) {
          return; // Silently skip.
        }
        throw new SchedulerError(
          "cap_exceeded",
          `task "${current.id}" is already at its max_concurrent limit (${current.max_concurrent})`,
        );
      }
    }

    // -- capability enforcement (AFTER guardrail checks, BEFORE handler invocation) --
    // Defense-in-depth: the host union (#grants) is the absolute CEILING, then the
    // per-task grant is the tightening that actually gates this task. Both must
    // pass. Deny-by-default is free: a task with no grant row reads as [] caps, so
    // any required capability is denied (matches the unknown-handler refuse posture).
    if (current.required_capabilities.length > 0) {
      const grant = this.#store.getTaskGrant(current.handler_id);
      const granted = grant?.capabilities ?? [];
      try {
        // Ceiling first so its error message attributes union-denied caps correctly.
        assertCapabilities(current.required_capabilities, this.#grants);
        assertCapabilities(current.required_capabilities, granted);
      } catch (capErr) {
        if (capErr instanceof CapabilityError) {
          const errorMsg = capErr.message;
          this.#persistence.updateLastRun(current.id, now.getTime(), errorMsg);
          if (isScheduled) {
            // Record denial, disable the task.
            this.#persistence.updateGuardrails(current.id, {
              enabled: false,
              last_error: errorMsg,
            });
            return; // Do NOT invoke the handler; do NOT trigger backoff.
          }
          // Manual run: surface the CapabilityError to the caller.
          throw capErr;
        }
        throw capErr;
      }
    }

    // -- track in-flight --
    this.#inFlight.set(current.id, (this.#inFlight.get(current.id) ?? 0) + 1);

    // Allocate the run row up front (status 'running') so the live tree shows the
    // run while it is still in flight, and sub-agents can attach to a real id.
    const runId = this.#store.startRun({ pipeline: current.handler_id, parentRunId: null });
    const startedAt = performance.now();
    // Tracks whether the run row has reached a terminal status. Declared outside
    // the try so the catch path can tell whether the handler already finalized the
    // row via recordRun (and therefore must NOT be clobbered with status 'error').
    let rowFinalized = false;

    try {
      const handler = this.#registry.get(current.handler_id);
      // Hold the handler's recorded outcome in a ref object: the closure mutation
      // in `onRecordRun` is invisible to control-flow narrowing, so reading
      // `.current` after the awaited handler call yields the full `... | null` type
      // (a bare `let` narrows to `never` here).
      const recordedRef: { current: { runId: string; status: string; summary: string } | null } = {
        current: null,
      };
      const ctx = buildPipelineContext({
        task: current,
        now,
        runId,
        parentRunId: null,
        store: this.#store,
        events: this.#events,
        registry: this.#registry,
        grants: this.#grants,
        parentTaskCapabilities: current.required_capabilities,
        maxFanout: this.#maxFanout,
        spawn: this.#makeSpawn(runId, current, startedAt),
        onRecordRun: (record) => {
          recordedRef.current = record;
          rowFinalized = true;
        },
        redactSummaries: this.#redactSummaries,
        ...(this.#complete !== undefined ? { complete: this.#complete } : {}),
        ...(options !== undefined ? { options } : {}),
      });

      // -- duration cap: race the handler against the shared timeout helper. --
      await withTimeout(
        () => handler(ctx),
        current.max_duration_ms,
        `task "${current.id}" exceeded max_duration_ms (${current.max_duration_ms}ms)`,
      );
      const durationMs = Math.round(performance.now() - startedAt);
      const recorded = recordedRef.current;

      // Finalize the row even when the handler never called recordRun, so no
      // dangling 'running' row is left behind.
      if (recorded === null) {
        this.#store.finishRun({ runId, status: "ok", summary: "" });
        rowFinalized = true;
      }

      // Build the outcome once — for the manual caller AND the run:completed event.
      // runId is always the up-front allocated id (never null now).
      const outcome: RunOutcome = {
        taskId: current.id,
        runId,
        status: recorded?.status ?? null,
        summary: recorded?.summary ?? null,
        cli: options?.cli ?? null,
        durationMs,
      };
      if (capture !== undefined) capture.outcome = outcome;
      // Live signal for the UI (manual + scheduled runs both reach here).
      this.#events.emit(RUN_COMPLETED, outcome);

      // Success: record run, reset backoff, update daily counter.
      this.#persistence.updateLastRun(current.id, now.getTime(), null);

      // Reset backoff state on success.
      const guardrailUpdate: {
        attempt_count: number;
        next_attempt_at: number | null;
        runs_today?: number;
        runs_today_date?: string | null;
      } = {
        attempt_count: 0,
        next_attempt_at: null,
      };

      // Update daily counter for scheduled runs.
      if (isScheduled && current.max_runs_per_day !== null) {
        const todayStr = toDateString(now);
        const isNewDay = current.runs_today_date !== todayStr;
        const todayCount = isNewDay ? 0 : current.runs_today;
        guardrailUpdate.runs_today = todayCount + 1;
        guardrailUpdate.runs_today_date = todayStr;
      }

      this.#persistence.updateGuardrails(current.id, guardrailUpdate);
    } catch (cause) {
      const errorMsg = cause instanceof Error ? cause.message : String(cause);
      this.#persistence.updateLastRun(current.id, now.getTime(), errorMsg);
      // Transition the up-front run row to a terminal 'error' state — UNLESS the
      // handler already finalized it via recordRun (don't clobber its status).
      if (!rowFinalized) {
        this.#store.finishRun({ runId, status: "error", summary: errorMsg });
      }

      if (isScheduled) {
        // Increment attempt_count and compute backoff.
        const newAttemptCount = current.attempt_count + 1;

        if (newAttemptCount >= MAX_ATTEMPTS) {
          // Dead-letter: insert failed_tasks row and disable the task.
          this.#persistence.insertFailedTask({
            id: randomUUID(),
            task_id: current.id,
            run_at: now.getTime(),
            error: errorMsg,
            attempt_count: newAttemptCount,
          });
          this.#persistence.updateGuardrails(current.id, {
            attempt_count: newAttemptCount,
            next_attempt_at: null,
            enabled: false,
            last_error: errorMsg,
          });
        } else {
          const delay = backoffDelayMs(newAttemptCount);
          const nextAttempt = now.getTime() + delay;
          this.#persistence.updateGuardrails(current.id, {
            attempt_count: newAttemptCount,
            next_attempt_at: nextAttempt,
          });
        }
      }

      throw cause;
    } finally {
      // Decrement in-flight counter.
      const current_in_flight = this.#inFlight.get(current.id) ?? 1;
      if (current_in_flight <= 1) {
        this.#inFlight.delete(current.id);
      } else {
        this.#inFlight.set(current.id, current_in_flight - 1);
      }
      // Drop this run's fan-out counter (entry is per-invocation).
      this.#childCounts.delete(runId);
    }
  }

  /**
   * Build the `spawn` function injected into a top-level run's context. Each call
   * increments the per-parent fan-out counter and delegates to {@link runSubAgent},
   * which enforces the two-sided capability gate, depth, and fan-out, allocates the
   * child row, and runs the registered child handler in-process.
   *
   * `parentRemainingMs` is computed at spawn time from the parent's
   * `max_duration_ms` minus elapsed wall-clock, so a child inherits (never
   * exceeds) the parent's remaining budget.
   */
  #makeSpawn(
    parentRunId: string,
    parentTask: ScheduledTask,
    parentStartedAt: number,
  ): (descriptor: SubAgentDescriptor, parent: PipelineContext) => SubAgentHandle {
    return (descriptor, parent) => {
      const parentRemainingMs =
        parentTask.max_duration_ms === null
          ? null
          : Math.max(0, parentTask.max_duration_ms - (performance.now() - parentStartedAt));

      const handle = runSubAgent({
        descriptor,
        parent,
        store: this.#store,
        events: this.#events,
        registry: this.#registry,
        grants: this.#grants,
        parentTaskCapabilities: parentTask.required_capabilities,
        ...(this.#complete !== undefined ? { complete: this.#complete } : {}),
        redactSummaries: this.#redactSummaries,
        parentRemainingMs,
        depth: 0,
        maxFanout: this.#maxFanout,
        childCount: () => this.#childCounts.get(parentRunId) ?? 0,
      });

      // Count this child only after runSubAgent accepted it (gates passed).
      this.#childCounts.set(parentRunId, (this.#childCounts.get(parentRunId) ?? 0) + 1);
      return handle;
    };
  }

  #subscribeEvent(task: ScheduledTask): void {
    const listener = (_payload?: unknown): void => {
      // Re-fetch the task so the event listener always uses current state.
      const current = this.#persistence.get(task.id);
      if (current === null || !current.enabled) return;

      // Fire-and-forget. We cannot await here (EventEmitter is sync). Errors are
      // recorded in last_error by #invoke; swallow the rejection so it does not
      // surface as an unhandled promise rejection.
      void this.#invoke(current, true).catch(() => {});
    };
    this.#eventListeners.set(task.id, listener);
    this.#events.on(task.schedule_expr, listener);
  }

  #unsubscribeEvent(id: string): void {
    const listener = this.#eventListeners.get(id);
    if (listener === undefined) return;
    const task = this.#persistence.get(id);
    if (task !== null) {
      this.#events.off(task.schedule_expr, listener);
    }
    this.#eventListeners.delete(id);
  }

  /** Expose the event bus so callers can emit topics. */
  get eventBus(): EventBus {
    return this.#events;
  }
}
