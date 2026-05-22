import { SchedulerError } from "./errors.ts";
import type { TaskHandler } from "./types.ts";

/**
 * Registry mapping string handler IDs to {@link TaskHandler} functions.
 *
 * Handlers must be registered before tasks that reference them are executed.
 * All handler IDs are allowlisted — there is no dynamic evaluation.
 */
export class HandlerRegistry {
  readonly #handlers: Map<string, TaskHandler> = new Map();

  /**
   * Register a handler under the given ID.
   *
   * Overwrites any previously registered handler with the same ID.
   */
  register(id: string, handler: TaskHandler): void {
    this.#handlers.set(id, handler);
  }

  /**
   * Retrieve a handler by ID.
   *
   * Throws {@link SchedulerError} with reason `"unknown_handler"` if no handler
   * is registered under `id`.
   */
  get(id: string): TaskHandler {
    const handler = this.#handlers.get(id);
    if (handler === undefined) {
      throw new SchedulerError("unknown_handler", `no handler registered for id "${id}"`);
    }
    return handler;
  }

  /** Returns true if a handler is registered under `id`. */
  has(id: string): boolean {
    return this.#handlers.has(id);
  }
}
