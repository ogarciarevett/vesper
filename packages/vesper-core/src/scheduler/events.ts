import { EventEmitter } from "node:events";

/** Listener signature for event bus topics. */
export type EventListener = (payload?: unknown) => void;

/**
 * Internal topic the scheduler emits a {@link import("./types.ts").RunOutcome} on
 * after every completed run (manual or scheduled). Namespaced so it never collides
 * with a user-defined event-task topic. Subscribe via `scheduler.eventBus.on(...)`.
 */
export const RUN_COMPLETED = "vesper:run:completed";

/**
 * High-volume topic the runtime emits a per-step live-trace event on whenever a
 * handler calls `ctx.emitProgress` or a sub-agent is spawned/completes. Payload
 * shape: `{ runId, parentRunId, kind, message, data? }`. Separate from
 * {@link RUN_COMPLETED} (which fires once per top-level run); a single run emits
 * many `RUN_EVENT`s. Subscribe via `scheduler.eventBus.on(...)`.
 */
export const RUN_EVENT = "vesper:run:event";

/**
 * Thin in-process event bus wrapping Node.js `EventEmitter`.
 *
 * Topics are plain strings; payloads are untyped (`unknown`).
 * This bus is intentionally minimal — no persistence, no replay.
 */
export class EventBus {
  readonly #emitter: EventEmitter = new EventEmitter();

  /** Emit `topic` to all registered listeners, optionally with `payload`. */
  emit(topic: string, payload?: unknown): void {
    this.#emitter.emit(topic, payload);
  }

  /** Subscribe `listener` to `topic`. */
  on(topic: string, listener: EventListener): void {
    this.#emitter.on(topic, listener);
  }

  /** Unsubscribe `listener` from `topic`. */
  off(topic: string, listener: EventListener): void {
    this.#emitter.off(topic, listener);
  }

  /** Remove all listeners for `topic` (or all topics if omitted). */
  removeAllListeners(topic?: string): void {
    if (topic !== undefined) {
      this.#emitter.removeAllListeners(topic);
    } else {
      this.#emitter.removeAllListeners();
    }
  }
}
