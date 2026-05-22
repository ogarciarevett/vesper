import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { assertCapabilities } from "../capabilities/assert.ts";
import { CapabilityError } from "../capabilities/errors.ts";
import type { Capability } from "../capabilities/index.ts";
import { cronMatches, parseCron } from "./cron.ts";
import { SchedulerError } from "./errors.ts";
import { EventBus } from "./events.ts";
import { TaskPersistence } from "./persistence.ts";
import type { HandlerRegistry } from "./registry.ts";
import type { RegisterTaskInput, ScheduledTask } from "./types.ts";

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
   * - Validates the cron expression for `kind = "cron"` tasks.
   * - Subscribes the handler to the event bus for `kind = "event"` tasks.
   * - Persists the task to the database.
   *
   * Throws:
   * - `SchedulerError("duplicate_task")` if `input.id` is already registered.
   * - `SchedulerError("invalid_cron")` if `kind = "cron"` and the expression is invalid.
   * - `SchedulerError("unknown_handler")` if `handler_id` is not in the registry.
   */
  register(input: RegisterTaskInput): ScheduledTask {
    // Verify the handler exists before persisting.
    this.#registry.get(input.handler_id);

    // Duplicate check.
    const existing = this.#persistence.get(input.id);
    if (existing !== null) {
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
      required_capabilities: input.required_capabilities ?? [],
    };

    this.#persistence.insert(task);

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
   * Throws `SchedulerError("unknown_task")` if `id` is not registered.
   */
  async run(id: string): Promise<void> {
    const task = this.#persistence.get(id);
    if (task === null) {
      throw new SchedulerError("unknown_task", `task "${id}" is not registered`);
    }

    await this.#invoke(task, false);
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
  async #invoke(task: ScheduledTask, isScheduled: boolean): Promise<void> {
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
    if (current.required_capabilities.length > 0) {
      try {
        assertCapabilities(current.required_capabilities, this.#grants);
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

    try {
      const handler = this.#registry.get(current.handler_id);

      // -- duration cap: race handler against timeout --
      let handlerPromise: Promise<void>;
      if (current.max_duration_ms !== null) {
        const timeoutMs = current.max_duration_ms;
        const timeoutPromise = new Promise<never>((_resolve, reject) =>
          setTimeout(
            () =>
              reject(new Error(`task "${current.id}" exceeded max_duration_ms (${timeoutMs}ms)`)),
            timeoutMs,
          ),
        );
        handlerPromise = Promise.race([
          Promise.resolve(handler({ task: current, now })),
          timeoutPromise,
        ]);
      } else {
        handlerPromise = Promise.resolve(handler({ task: current, now }));
      }

      await handlerPromise;

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
    }
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
