/**
 * In-process coordinator that bridges a blocking pipeline gate and an HTTP route
 * in the same daemon process.
 *
 * A running pipeline calls `awaitDecision(runId, changeId)` and waits on the
 * returned Promise. An HTTP route handler later calls `resolve(runId, changeId,
 * decision)` to unblock it with the human's approve/reject decision.
 *
 * Key design decisions:
 * - The internal Map is keyed by a `"${runId}\0${changeId}"` composite so ids
 *   with spaces cannot collide across the two dimensions.
 * - Calling `awaitDecision` twice for the same key supersedes the prior waiter
 *   (rejects it with ChangeDecisionError("superseded")) before registering the
 *   new one.
 * - `stop()` is idempotent and drains all waiters (daemon shutdown path).
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** The decision a human delivers for a pending change. */
export type ChangeDecision = {
  readonly decision: "approve" | "reject";
  readonly reason?: string;
};

/** Identity of a change currently awaiting a human decision. */
export interface PendingChange {
  readonly runId: string;
  readonly changeId: string;
}

/** Options for {@link ChangeDecisionCoordinator.awaitDecision}. */
export interface AwaitDecisionOptions {
  /**
   * When set to a positive number, the returned promise rejects with
   * {@link ChangeDecisionError}("timeout") after this many milliseconds
   * if no decision has arrived.
   *
   * `undefined` or `0` means no timeout — the promise waits indefinitely.
   */
  readonly timeoutMs?: number;
}

// ---------------------------------------------------------------------------
// ChangeDecisionError
// ---------------------------------------------------------------------------

/** Rejection reason for promises returned by {@link ChangeDecisionCoordinator.awaitDecision}. */
export class ChangeDecisionError extends Error {
  readonly reason: "timeout" | "superseded";

  constructor(reason: ChangeDecisionError["reason"], message: string) {
    super(message);
    this.name = "ChangeDecisionError";
    this.reason = reason;
  }
}

// ---------------------------------------------------------------------------
// Internal entry shape
// ---------------------------------------------------------------------------

interface PendingEntry {
  readonly runId: string;
  readonly changeId: string;
  readonly resolve: (decision: ChangeDecision) => void;
  readonly reject: (err: ChangeDecisionError) => void;
  readonly timer: ReturnType<typeof setTimeout> | undefined;
}

// ---------------------------------------------------------------------------
// ChangeDecisionCoordinator
// ---------------------------------------------------------------------------

export class ChangeDecisionCoordinator {
  readonly #waiters = new Map<string, PendingEntry>();

  /** Composite key that cannot be confused even when ids contain spaces. */
  #key(runId: string, changeId: string): string {
    return `${runId}\0${changeId}`;
  }

  /**
   * Block until `resolve()` is called for the same `(runId, changeId)`, or
   * until `timeoutMs` elapses (if set).
   *
   * If a waiter is already registered for the same key, it is rejected with
   * `ChangeDecisionError("superseded")` and replaced by this new one.
   */
  awaitDecision(
    runId: string,
    changeId: string,
    opts?: AwaitDecisionOptions,
  ): Promise<ChangeDecision> {
    const key = this.#key(runId, changeId);

    // Supersede any existing waiter for this key.
    const existing = this.#waiters.get(key);
    if (existing !== undefined) {
      this.#cancel(
        existing,
        new ChangeDecisionError("superseded", `${key} superseded by a new waiter`),
      );
    }

    return new Promise<ChangeDecision>((res, rej) => {
      const timeoutMs = opts?.timeoutMs;
      const useTimeout = typeof timeoutMs === "number" && timeoutMs > 0;

      let timer: ReturnType<typeof setTimeout> | undefined;
      if (useTimeout) {
        timer = setTimeout(() => {
          // Remove before rejecting so re-entrant callbacks see clean state.
          this.#waiters.delete(key);
          rej(
            new ChangeDecisionError(
              "timeout",
              `awaitDecision(${runId}, ${changeId}) timed out after ${timeoutMs}ms`,
            ),
          );
        }, timeoutMs);
      }

      const entry: PendingEntry = {
        runId,
        changeId,
        resolve: res,
        reject: rej,
        timer,
      };

      this.#waiters.set(key, entry);
    });
  }

  /**
   * Deliver a decision to the waiter registered for `(runId, changeId)`.
   *
   * Returns `true` if a waiter existed and was resolved, `false` otherwise.
   * Clears the pending entry and its timer before resolving.
   */
  resolve(runId: string, changeId: string, decision: ChangeDecision): boolean {
    const key = this.#key(runId, changeId);
    const entry = this.#waiters.get(key);
    if (entry === undefined) return false;

    // Clear timer and entry BEFORE resolving (re-entrant safety).
    if (entry.timer !== undefined) clearTimeout(entry.timer);
    this.#waiters.delete(key);
    entry.resolve(decision);
    return true;
  }

  /** Returns `true` if a waiter is currently pending for `(runId, changeId)`. */
  has(runId: string, changeId: string): boolean {
    return this.#waiters.has(this.#key(runId, changeId));
  }

  /** Snapshot of all currently-pending changes (order is insertion order). */
  pending(): readonly PendingChange[] {
    return Array.from(this.#waiters.values()).map(({ runId, changeId }) => ({ runId, changeId }));
  }

  /**
   * Reject ALL pending waiters with `ChangeDecisionError("superseded")` and
   * clear their timers. Call on daemon shutdown.
   */
  stop(): void {
    const entries = Array.from(this.#waiters.values());
    this.#waiters.clear();
    for (const entry of entries) {
      this.#cancel(entry, new ChangeDecisionError("superseded", `coordinator stopped`));
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /** Clear the timer and reject the entry. Does NOT touch the Map. */
  #cancel(entry: PendingEntry, err: ChangeDecisionError): void {
    if (entry.timer !== undefined) clearTimeout(entry.timer);
    entry.reject(err);
  }
}
