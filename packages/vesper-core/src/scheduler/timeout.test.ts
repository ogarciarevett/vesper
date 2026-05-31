import { describe, expect, test } from "bun:test";
import { remainingBudgetMs, withTimeout } from "./timeout.ts";

describe("withTimeout", () => {
  test("resolves a fast handler and leaves no pending timer", async () => {
    const result = await withTimeout(() => "fast", 50, "should not fire");
    expect(result).toBe("fast");
    // If a timer were left pending it would reject after 50ms; sleep past it to
    // prove the process is clean and nothing rejects.
    await new Promise((r) => setTimeout(r, 60));
    expect(result).toBe("fast");
  });

  test("resolves an async handler value", async () => {
    const result = await withTimeout(async () => 42, 100, "label");
    expect(result).toBe(42);
  });

  test("rejects with Error(label) when work exceeds the cap", async () => {
    const slow = () => new Promise((resolve) => setTimeout(() => resolve("late"), 100));
    await expect(withTimeout(slow, 5, "exceeded duration")).rejects.toThrow("exceeded duration");
  });

  test("never times out when ms is null", async () => {
    const slow = () => new Promise<string>((resolve) => setTimeout(() => resolve("done"), 20));
    const result = await withTimeout(slow, null, "unused");
    expect(result).toBe("done");
  });

  test("propagates a handler error verbatim", async () => {
    const boom = () => Promise.reject(new Error("handler boom"));
    await expect(withTimeout(boom, 100, "cap")).rejects.toThrow("handler boom");
  });
});

describe("remainingBudgetMs", () => {
  test("returns the parent remaining when the child cap is null", () => {
    expect(remainingBudgetMs(null, 500)).toBe(500);
  });

  test("returns the child cap when the parent is unbounded", () => {
    expect(remainingBudgetMs(300, null)).toBe(300);
  });

  test("returns null when both are unbounded", () => {
    expect(remainingBudgetMs(null, null)).toBeNull();
  });

  test("intersects with Math.min (child tighter)", () => {
    expect(remainingBudgetMs(100, 500)).toBe(100);
  });

  test("intersects with Math.min (parent tighter)", () => {
    expect(remainingBudgetMs(500, 100)).toBe(100);
  });
});
