import { describe, expect, test } from "bun:test";
import { ApprovalError } from "./errors.ts";
import { ApprovalTokenStore } from "./tokens.ts";

/** A deterministic clock seam whose current value the test controls. */
function fixedClock(start = 1_000): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return {
    now: () => t,
    advance: (ms) => {
      t += ms;
    },
  };
}

describe("ApprovalTokenStore", () => {
  test("mint returns a non-empty lowercase-hex code", () => {
    const store = new ApprovalTokenStore();
    const code = store.mint();
    expect(code).toMatch(/^[0-9a-f]+$/);
    expect(code.length).toBeGreaterThanOrEqual(16);
  });

  test("mint produces distinct codes (CSPRNG)", () => {
    const store = new ApprovalTokenStore();
    const codes = new Set([store.mint(), store.mint(), store.mint()]);
    expect(codes.size).toBe(3);
  });

  test("verify succeeds once for a valid code", () => {
    const store = new ApprovalTokenStore();
    const code = store.mint();
    expect(() => store.verify(code)).not.toThrow();
  });

  test("verify is single-use — a replay throws already_used", () => {
    const store = new ApprovalTokenStore();
    const code = store.mint();
    store.verify(code);
    try {
      store.verify(code);
      throw new Error("expected verify to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ApprovalError);
      expect((err as ApprovalError).reason).toBe("already_used");
    }
  });

  test("verify of an unknown code throws not_found", () => {
    const store = new ApprovalTokenStore();
    try {
      store.verify("deadbeef");
      throw new Error("expected verify to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ApprovalError);
      expect((err as ApprovalError).reason).toBe("not_found");
    }
  });

  test("verify of an expired code throws expired", () => {
    const clock = fixedClock();
    const store = new ApprovalTokenStore({ ttlMs: 100, now: clock.now });
    const code = store.mint();
    clock.advance(101);
    try {
      store.verify(code);
      throw new Error("expected verify to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ApprovalError);
      expect((err as ApprovalError).reason).toBe("expired");
    }
  });

  test("a code is valid right up to (but not at) its TTL boundary", () => {
    const clock = fixedClock();
    const store = new ApprovalTokenStore({ ttlMs: 100, now: clock.now });
    const code = store.mint();
    clock.advance(99);
    expect(store.isValid(code)).toBe(true);
    clock.advance(1); // now == expiresAt
    expect(store.isValid(code)).toBe(false);
  });

  test("isValid does not consume the code (verify still succeeds afterwards)", () => {
    const store = new ApprovalTokenStore();
    const code = store.mint();
    expect(store.isValid(code)).toBe(true);
    expect(store.isValid(code)).toBe(true);
    expect(() => store.verify(code)).not.toThrow();
  });

  test("isValid is false for unknown/used codes", () => {
    const store = new ApprovalTokenStore();
    expect(store.isValid("nope")).toBe(false);
    const code = store.mint();
    store.verify(code);
    expect(store.isValid(code)).toBe(false);
  });

  test("prune drops expired and used entries (later verify is not_found)", () => {
    const clock = fixedClock();
    const store = new ApprovalTokenStore({ ttlMs: 100, now: clock.now });
    const expiring = store.mint();
    clock.advance(101);
    store.prune();
    try {
      store.verify(expiring);
      throw new Error("expected verify to throw");
    } catch (err) {
      expect((err as ApprovalError).reason).toBe("not_found");
    }
  });

  test("ttl is clamped to a minimum of 1ms", () => {
    const clock = fixedClock();
    const store = new ApprovalTokenStore({ ttlMs: 0, now: clock.now });
    const code = store.mint();
    // With ttl clamped to >=1, the code is valid at mint time (now < expiresAt).
    expect(store.isValid(code)).toBe(true);
  });

  test("injected randomBytes seam is used (deterministic code)", () => {
    const store = new ApprovalTokenStore({
      randomBytes: (out) => out.fill(0xab),
    });
    const code = store.mint();
    expect(code).toBe("ab".repeat(code.length / 2));
  });
});
