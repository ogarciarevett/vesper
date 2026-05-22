import type { Database } from "bun:sqlite";
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

  /**
   * Map of task id -> bound event listener, so event tasks can be cleanly
   * unsubscribed when unregistered.
   */
  readonly #eventListeners: Map<string, (payload?: unknown) => void> = new Map();

  constructor(options: SchedulerOptions) {
    this.#persistence = new TaskPersistence(options.db);
    this.#registry = options.registry;
    this.#clock = options.clock ?? (() => new Date());
    this.#events = options.events ?? new EventBus();

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
   *
   * Throws `SchedulerError("unknown_task")` if `id` is not registered.
   */
  async run(id: string): Promise<void> {
    const task = this.#persistence.get(id);
    if (task === null) {
      throw new SchedulerError("unknown_task", `task "${id}" is not registered`);
    }

    await this.#invoke(task);
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
          await this.#invoke(task);
        } catch {
          // Per-task failure is already recorded in last_error; isolate it so one
          // bad task does not abort the others due in this tick. Backoff and
          // dead-lettering are DEV-108.
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
   * On any failure (unknown handler or a throwing handler) the original error is
   * re-thrown after being recorded. Callers decide how to react:
   * `run()` propagates it to the manual caller; `tick()` and event listeners
   * isolate it (the failure is already persisted in last_error).
   */
  async #invoke(task: ScheduledTask): Promise<void> {
    const now = this.#clock();
    try {
      const handler = this.#registry.get(task.handler_id);
      await handler({ task, now });
      this.#persistence.updateLastRun(task.id, now.getTime(), null);
    } catch (cause) {
      this.#persistence.updateLastRun(
        task.id,
        now.getTime(),
        cause instanceof Error ? cause.message : String(cause),
      );
      throw cause;
    }
  }

  #subscribeEvent(task: ScheduledTask): void {
    const listener = (_payload?: unknown): void => {
      // Fire-and-forget. We cannot await here (EventEmitter is sync). Errors are
      // recorded in last_error by #invoke; swallow the rejection so it does not
      // surface as an unhandled promise rejection.
      void this.#invoke(task).catch(() => {});
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
