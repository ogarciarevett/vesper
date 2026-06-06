/**
 * Tests for ChangeDecisionCoordinator.
 *
 * - awaitDecision() blocks until resolve() delivers a ChangeDecision.
 * - Supersede: a second awaitDecision for the same key rejects the first waiter.
 * - Timeout: a waiter with a timeoutMs that elapses rejects with ChangeDecisionError("timeout").
 * - Resolving before timeout fires does NOT later reject (timer cleared).
 * - stop() rejects all pending waiters with ChangeDecisionError("superseded").
 * - has() / pending() reflect live state.
 */

import { describe, expect, test } from "bun:test";
import {
  type ChangeDecision,
  ChangeDecisionCoordinator,
  ChangeDecisionError,
  type PendingChange,
} from "./changes.ts";

// ---------------------------------------------------------------------------
// resolve() unblocks a pending awaiter
// ---------------------------------------------------------------------------

describe("resolve unblocks awaitDecision", () => {
  test("approve decision is delivered exactly", async () => {
    const coord = new ChangeDecisionCoordinator();
    const promise = coord.awaitDecision("run-1", "change-1");
    const decision: ChangeDecision = { decision: "approve" };
    const resolved = coord.resolve("run-1", "change-1", decision);
    expect(resolved).toBe(true);
    const result = await promise;
    expect(result).toEqual(decision);
  });

  test("reject decision with reason is delivered exactly", async () => {
    const coord = new ChangeDecisionCoordinator();
    const promise = coord.awaitDecision("run-2", "change-2");
    const decision: ChangeDecision = { decision: "reject", reason: "too risky" };
    coord.resolve("run-2", "change-2", decision);
    const result = await promise;
    expect(result).toEqual(decision);
  });
});

// ---------------------------------------------------------------------------
// resolve() with no matching waiter
// ---------------------------------------------------------------------------

describe("resolve with no matching waiter", () => {
  test("returns false when no waiter exists for (runId, changeId)", () => {
    const coord = new ChangeDecisionCoordinator();
    const resolved = coord.resolve("unknown-run", "unknown-change", { decision: "approve" });
    expect(resolved).toBe(false);
  });

  test("returns false after the waiter has already been resolved", async () => {
    const coord = new ChangeDecisionCoordinator();
    const promise = coord.awaitDecision("run-3", "change-3");
    coord.resolve("run-3", "change-3", { decision: "approve" });
    await promise;
    // Second resolve for the same key — entry was cleared.
    const second = coord.resolve("run-3", "change-3", { decision: "reject" });
    expect(second).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// has() and pending() reflect live state
// ---------------------------------------------------------------------------

describe("has() and pending()", () => {
  test("has() is false before awaitDecision is called", () => {
    const coord = new ChangeDecisionCoordinator();
    expect(coord.has("r", "c")).toBe(false);
  });

  test("has() is true while a waiter is pending", () => {
    const coord = new ChangeDecisionCoordinator();
    coord.awaitDecision("r", "c");
    expect(coord.has("r", "c")).toBe(true);
  });

  test("has() is false after resolve()", async () => {
    const coord = new ChangeDecisionCoordinator();
    const p = coord.awaitDecision("r", "c");
    coord.resolve("r", "c", { decision: "approve" });
    expect(coord.has("r", "c")).toBe(false);
    await p;
  });

  test("pending() is empty initially", () => {
    const coord = new ChangeDecisionCoordinator();
    expect(coord.pending()).toEqual([]);
  });

  test("pending() lists all active waiters", () => {
    const coord = new ChangeDecisionCoordinator();
    coord.awaitDecision("r1", "c1");
    coord.awaitDecision("r2", "c2");
    const items = coord.pending();
    expect(items).toHaveLength(2);
    const found = (runId: string, changeId: string): boolean =>
      items.some((p: PendingChange) => p.runId === runId && p.changeId === changeId);
    expect(found("r1", "c1")).toBe(true);
    expect(found("r2", "c2")).toBe(true);
  });

  test("pending() removes the entry after resolve()", async () => {
    const coord = new ChangeDecisionCoordinator();
    const p = coord.awaitDecision("r1", "c1");
    coord.awaitDecision("r2", "c2");
    coord.resolve("r1", "c1", { decision: "approve" });
    await p;
    const items = coord.pending();
    expect(items).toHaveLength(1);
    expect(items[0]?.runId).toBe("r2");
  });
});

// ---------------------------------------------------------------------------
// Supersede: second awaitDecision for the same key
// ---------------------------------------------------------------------------

describe("supersede: second awaitDecision for the same (runId, changeId)", () => {
  test("rejects the first waiter with ChangeDecisionError('superseded')", async () => {
    const coord = new ChangeDecisionCoordinator();
    const first = coord.awaitDecision("r", "c");
    // Replace the waiter; the second stays pending — resolve it so no dangling waiter remains.
    const second = coord.awaitDecision("r", "c");
    await expect(first).rejects.toThrow(ChangeDecisionError);
    await expect(first).rejects.toMatchObject({ reason: "superseded" });
    coord.resolve("r", "c", { decision: "approve" });
    await second; // drain
  });

  test("second waiter resolves normally after supersede", async () => {
    const coord = new ChangeDecisionCoordinator();
    coord.awaitDecision("r", "c").catch(() => {}); // first — will be superseded; suppress unhandled rejection
    const second = coord.awaitDecision("r", "c");
    coord.resolve("r", "c", { decision: "approve" });
    const result = await second;
    expect(result.decision).toBe("approve");
  });

  test("only one waiter lives after supersede", () => {
    const coord = new ChangeDecisionCoordinator();
    coord.awaitDecision("r", "c").catch(() => {}); // first — will be superseded; suppress unhandled rejection
    coord.awaitDecision("r", "c").catch(() => {}); // second — stays pending; catch is a no-op here
    // pending() should list the key only once.
    expect(coord.pending()).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Timeout
// ---------------------------------------------------------------------------

describe("timeout", () => {
  test("rejects with ChangeDecisionError('timeout') when timeoutMs elapses", async () => {
    const coord = new ChangeDecisionCoordinator();
    const promise = coord.awaitDecision("r", "c", { timeoutMs: 10 });
    await expect(promise).rejects.toThrow(ChangeDecisionError);
    await expect(promise).rejects.toMatchObject({ reason: "timeout" });
  });

  test("entry is removed from pending after timeout fires", async () => {
    const coord = new ChangeDecisionCoordinator();
    const promise = coord.awaitDecision("r", "c", { timeoutMs: 10 });
    await promise.catch(() => {
      // expected rejection
    });
    expect(coord.has("r", "c")).toBe(false);
    expect(coord.pending()).toHaveLength(0);
  });

  test("resolving before timeout fires does not cause a later rejection", async () => {
    const coord = new ChangeDecisionCoordinator();
    // 50 ms timeout — we will resolve immediately before it fires.
    const promise = coord.awaitDecision("r", "c", { timeoutMs: 50 });
    coord.resolve("r", "c", { decision: "approve" });
    const result = await promise;
    expect(result.decision).toBe("approve");
    // Wait past the original timeout to confirm no unhandled rejection occurs.
    await new Promise<void>((res) => setTimeout(res, 60));
  });

  test("timeoutMs of 0 is treated as no timeout (waits indefinitely until resolved)", async () => {
    const coord = new ChangeDecisionCoordinator();
    const promise = coord.awaitDecision("r", "c", { timeoutMs: 0 });
    // Give event-loop a tick to confirm nothing fires immediately.
    await new Promise<void>((res) => setTimeout(res, 20));
    expect(coord.has("r", "c")).toBe(true);
    coord.resolve("r", "c", { decision: "reject" });
    const result = await promise;
    expect(result.decision).toBe("reject");
  });
});

// ---------------------------------------------------------------------------
// stop()
// ---------------------------------------------------------------------------

describe("stop()", () => {
  test("rejects all pending waiters with ChangeDecisionError('superseded')", async () => {
    const coord = new ChangeDecisionCoordinator();
    const p1 = coord.awaitDecision("r1", "c1");
    const p2 = coord.awaitDecision("r2", "c2");
    coord.stop();
    await expect(p1).rejects.toMatchObject({ reason: "superseded" });
    await expect(p2).rejects.toMatchObject({ reason: "superseded" });
  });

  test("pending() is empty after stop()", () => {
    const coord = new ChangeDecisionCoordinator();
    coord.awaitDecision("r1", "c1").catch(() => {}); // will be rejected by stop(); suppress unhandled rejection
    coord.awaitDecision("r2", "c2").catch(() => {}); // same
    coord.stop();
    expect(coord.pending()).toHaveLength(0);
  });

  test("stop() on an empty coordinator does not throw", () => {
    const coord = new ChangeDecisionCoordinator();
    expect(() => coord.stop()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Key isolation: different (runId, changeId) pairs do not interfere
// ---------------------------------------------------------------------------

describe("key isolation", () => {
  test("different run IDs are independent", async () => {
    const coord = new ChangeDecisionCoordinator();
    const p1 = coord.awaitDecision("r1", "c");
    const p2 = coord.awaitDecision("r2", "c");
    coord.resolve("r1", "c", { decision: "approve" });
    const r1 = await p1;
    expect(r1.decision).toBe("approve");
    // r2 is still pending.
    expect(coord.has("r2", "c")).toBe(true);
    coord.resolve("r2", "c", { decision: "reject" });
    const r2 = await p2;
    expect(r2.decision).toBe("reject");
  });

  test("different change IDs under the same run are independent", async () => {
    const coord = new ChangeDecisionCoordinator();
    const p1 = coord.awaitDecision("r", "c1");
    const p2 = coord.awaitDecision("r", "c2");
    coord.resolve("r", "c2", { decision: "reject" });
    const r2 = await p2;
    expect(r2.decision).toBe("reject");
    expect(coord.has("r", "c1")).toBe(true);
    coord.stop();
    await expect(p1).rejects.toMatchObject({ reason: "superseded" });
  });
});
