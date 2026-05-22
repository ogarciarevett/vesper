import { EventEmitter } from "node:events";

/** Listener signature for event bus topics. */
export type EventListener = (payload?: unknown) => void;

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
