import { describe, expect, test } from "bun:test";
import type { CompleteResult } from "../cli/types.ts";
import type { CompleteFn } from "../scheduler/types.ts";
import { SkillTrainError } from "./errors.ts";
import { contains, exactMatch, makeJudge, resolveScorer } from "./scorers.ts";

/** Build a fake CompleteFn that returns a fixed text and records its inputs. */
function fakeComplete(text: string): {
  readonly fn: CompleteFn;
  readonly calls: { prompt: string; opts?: { readonly cli?: string } }[];
} {
  const calls: { prompt: string; opts?: { readonly cli?: string } }[] = [];
  const fn: CompleteFn = async (prompt, opts) => {
    calls.push({ prompt, ...(opts !== undefined ? { opts } : {}) });
    const result: CompleteResult = {
      text,
      exit_code: 0,
      raw_stdout: text,
      raw_stderr: "",
      duration_ms: 1,
    };
    return result;
  };
  return { fn, calls };
}

describe("exactMatch", () => {
  test("equal strings (with surrounding whitespace) score 1", () => {
    expect(exactMatch("  hello  ", "hello")).toBe(1);
  });

  test("different strings score 0", () => {
    expect(exactMatch("hello", "world")).toBe(0);
  });
});

describe("contains", () => {
  test("case-insensitive substring scores 1", () => {
    expect(contains("The Quick Brown Fox", "quick brown")).toBe(1);
  });

  test("absent substring scores 0", () => {
    expect(contains("hello world", "goodbye")).toBe(0);
  });

  test("empty expected scores 1", () => {
    expect(contains("anything", "   ")).toBe(1);
  });
});

describe("makeJudge", () => {
  test("parses a bare number", async () => {
    const judge = makeJudge(fakeComplete("0.8").fn);
    expect(await judge("a", "b")).toBe(0.8);
  });

  test("parses a number embedded in prose", async () => {
    const judge = makeJudge(fakeComplete("Score: 0.5 out of 1").fn);
    expect(await judge("a", "b")).toBe(0.5);
  });

  test("ignores a preamble integer and reads the decimal score", async () => {
    // Regression: a leading integer (e.g. "Task 1") must not be read as 1.0.
    const judge = makeJudge(fakeComplete("Task 1 rating: 0.9").fn);
    expect(await judge("a", "b")).toBe(0.9);
  });

  test("reads the score, not the scale, in 'X out of 1.0'", async () => {
    const judge = makeJudge(fakeComplete("0.4 out of 1.0").fn);
    expect(await judge("a", "b")).toBe(0.4);
  });

  test("falls back to an integer when there is no decimal", async () => {
    expect(await makeJudge(fakeComplete("1").fn)("a", "b")).toBe(1);
    expect(await makeJudge(fakeComplete("0").fn)("a", "b")).toBe(0);
  });

  test("returns 0 when no number is present", async () => {
    const judge = makeJudge(fakeComplete("garbage no number").fn);
    expect(await judge("a", "b")).toBe(0);
  });

  test("clamps values above 1 down to 1", async () => {
    const judge = makeJudge(fakeComplete("1.7").fn);
    expect(await judge("a", "b")).toBe(1);
  });

  test("clamps negative values up to 0", async () => {
    const judge = makeJudge(fakeComplete("-0.3").fn);
    expect(await judge("a", "b")).toBe(0);
  });

  test("sends a non-empty prompt to the CLI", async () => {
    const fake = fakeComplete("1.0");
    const judge = makeJudge(fake.fn);
    await judge("actual answer", "expected answer");
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]?.prompt.length).toBeGreaterThan(0);
    expect(fake.calls[0]?.prompt).toContain("expected answer");
    expect(fake.calls[0]?.prompt).toContain("actual answer");
  });

  test("forwards opts.cli as { cli } to complete", async () => {
    const fake = fakeComplete("1.0");
    const judge = makeJudge(fake.fn, { cli: "codex" });
    await judge("a", "b");
    expect(fake.calls[0]?.opts).toEqual({ cli: "codex" });
  });

  test("omits opts when no cli is configured", async () => {
    const fake = fakeComplete("1.0");
    const judge = makeJudge(fake.fn);
    await judge("a", "b");
    expect(fake.calls[0]?.opts).toBeUndefined();
  });
});

describe("resolveScorer", () => {
  test("resolves exact_match", () => {
    expect(resolveScorer("exact_match")).toBe(exactMatch);
  });

  test("resolves contains", () => {
    expect(resolveScorer("contains")).toBe(contains);
  });

  test("resolves judge when a judge dep is provided", () => {
    const judge = makeJudge(fakeComplete("1.0").fn);
    expect(resolveScorer("judge", { judge })).toBe(judge);
  });

  test("throws SkillTrainError(invalid_tasks) for judge without a dep", () => {
    expect(() => resolveScorer("judge")).toThrow(SkillTrainError);
    try {
      resolveScorer("judge");
      throw new Error("expected resolveScorer to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(SkillTrainError);
      expect((error as SkillTrainError).reason).toBe("invalid_tasks");
    }
  });
});
