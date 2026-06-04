/**
 * Holds the registered {@link ChannelHandler}s and starts their inbound loops.
 * Modeled exactly on the shipped `ModuleRegistry`: per-handler failure isolation
 * (one handler throwing during `startAll` never breaks the others), empty by
 * default. Only catalog entries with a stored credential AND
 * `connections.<id>.enabled === true` are registered by the daemon.
 */

import type { ChannelHandler, ChannelId, ChatSink, Stoppable } from "./types.ts";

export class ChannelRegistry {
  readonly #handlers: ChannelHandler[] = [];

  constructor(handlers: readonly ChannelHandler[] = []) {
    this.#handlers.push(...handlers);
  }

  /** Register a handler. A second handler for the same channel id replaces nothing — registration is additive; the daemon registers at most one per channel. */
  register(handler: ChannelHandler): void {
    this.#handlers.push(handler);
  }

  list(): readonly ChannelHandler[] {
    return this.#handlers;
  }

  byId(id: ChannelId): ChannelHandler | undefined {
    return this.#handlers.find((h) => h.descriptor.id === id);
  }

  /**
   * Start every registered handler's inbound loop, wiring each to `sink`. A
   * handler that throws synchronously while starting is isolated (logged-by-
   * swallowing) so one misbehaving channel cannot stop the others — the same
   * failure-isolation contract as `ModuleRegistry.dispatchRunCompleted`. Returns
   * a single {@link Stoppable} that stops every started loop (idempotent).
   */
  startAll(sink: ChatSink): Stoppable {
    const handles: Stoppable[] = [];
    for (const handler of this.#handlers) {
      try {
        handles.push(handler.receive(sink));
      } catch {
        // A misbehaving handler must not prevent the others from receiving.
      }
    }
    let stopped = false;
    return {
      stop() {
        if (stopped) return;
        stopped = true;
        for (const h of handles) {
          try {
            h.stop();
          } catch {
            // Best-effort teardown; one handler's failure must not block the rest.
          }
        }
      },
    };
  }
}
