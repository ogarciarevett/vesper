/** Scorers for the skill-train validation harness (SkillOpt-style optimization). */

import type { CompleteFn } from "../scheduler/types.ts";
import { SkillTrainError } from "./errors.ts";
import type { Scorer, ScorerName } from "./types.ts";

/** 1 when trimmed strings are equal, else 0. */
export function exactMatch(actual: string, expected: string): number {
  return actual.trim() === expected.trim() ? 1 : 0;
}

/** 1 when `actual` contains `expected` (case-insensitive, trimmed), else 0. Empty expected -> 1. */
export function contains(actual: string, expected: string): number {
  const needle = expected.trim();
  if (needle === "") {
    return 1;
  }
  return actual.toLowerCase().includes(needle.toLowerCase()) ? 1 : 0;
}

/** Matches the first floating-point number in judge output (e.g. "Score: 0.8", "0.8/1.0"). */
const FIRST_NUMBER = /-?\d+(?:\.\d+)?/;

/** Clamp a value into the [0, 1] interval. */
function clamp01(value: number): number {
  if (value < 0) {
    return 0;
  }
  if (value > 1) {
    return 1;
  }
  return value;
}

/**
 * Build an async LLM-as-judge scorer that asks the CLI to grade 0.0-1.0.
 *
 * The returned scorer routes through the injected {@link CompleteFn} (the CLI
 * adapter layer — never a provider SDK, per Hard rule 12). It parses the FIRST
 * floating-point number from the response, clamps it to [0, 1], and NEVER
 * throws: unparseable output yields 0.
 */
export function makeJudge(complete: CompleteFn, opts?: { readonly cli?: string }): Scorer {
  return async (actual: string, expected: string): Promise<number> => {
    const prompt = buildJudgePrompt(actual, expected);
    const result = await complete(prompt, opts?.cli !== undefined ? { cli: opts.cli } : undefined);
    const match = result.text.match(FIRST_NUMBER);
    if (match === null) {
      return 0;
    }
    const parsed = Number.parseFloat(match[0]);
    if (Number.isNaN(parsed)) {
      return 0;
    }
    return clamp01(parsed);
  };
}

/** Build the grading instruction handed to the judge CLI. */
function buildJudgePrompt(actual: string, expected: string): string {
  return [
    "You are grading how well an ACTUAL response satisfies an EXPECTED answer.",
    "Output ONLY a single number from 0.0 to 1.0 (1.0 = fully satisfies, 0.0 = not at all).",
    "Do not explain. Do not add any other text.",
    "",
    "EXPECTED:",
    expected,
    "",
    "ACTUAL:",
    actual,
    "",
    "Score (0.0 to 1.0):",
  ].join("\n");
}

/**
 * Resolve a {@link ScorerName} to a {@link Scorer}. The `judge` scorer requires
 * a pre-built judge in `deps.judge` (a target needs `makeJudge` wired with a
 * CLI); otherwise this throws so the caller surfaces a clear configuration error.
 */
export function resolveScorer(name: ScorerName, deps?: { readonly judge?: Scorer }): Scorer {
  switch (name) {
    case "exact_match":
      return exactMatch;
    case "contains":
      return contains;
    case "judge": {
      if (deps?.judge !== undefined) {
        return deps.judge;
      }
      throw new SkillTrainError(
        "invalid_tasks",
        "a task requests the 'judge' scorer but no judge was configured (pass --judge-cli)",
      );
    }
    default: {
      const exhaustive: never = name;
      throw new SkillTrainError("invalid_tasks", `unknown scorer: ${String(exhaustive)}`);
    }
  }
}
