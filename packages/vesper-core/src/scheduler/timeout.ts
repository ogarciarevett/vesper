/**
 * Shared duration-cap helper, factored out of the scheduler so both the
 * top-level `#invoke` path and the sub-agent path race a handler against the
 * same timeout with identical clear-in-finally semantics.
 */

/**
 * Run `work` with an optional duration cap.
 *
 * - `ms === null` -> no cap; awaits `work()` directly.
 * - otherwise -> races `work()` against a timer that rejects with `Error(label)`
 *   after `ms` milliseconds. The timer handle is cleared in `finally` so a fast
 *   handler never leaves a pending timer keeping the event loop alive.
 */
export async function withTimeout<T>(
  work: () => Promise<T> | T,
  ms: number | null,
  label: string,
): Promise<T> {
  if (ms === null) {
    return await Promise.resolve(work());
  }

  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timeoutHandle = setTimeout(() => reject(new Error(label)), ms);
    });
    return await Promise.race([Promise.resolve(work()), timeoutPromise]);
  } finally {
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
  }
}

/**
 * Compute a child's effective duration budget by intersecting its own cap
 * (`maxDurationMs`, or null = unbounded) with the parent's remaining budget.
 *
 * `parentRemainingMs` is the time the parent still has before ITS own cap fires
 * (null = the parent is unbounded). Returns the tighter of the two, or null when
 * both are unbounded — a sub-agent inherits, never exceeds, the parent budget.
 */
export function remainingBudgetMs(
  maxDurationMs: number | null,
  parentRemainingMs: number | null,
): number | null {
  if (maxDurationMs === null) return parentRemainingMs;
  if (parentRemainingMs === null) return maxDurationMs;
  return Math.min(maxDurationMs, parentRemainingMs);
}
