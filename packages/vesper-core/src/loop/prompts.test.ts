/** Tests for the loop meta-prompts and the fail-closed verdict parser. */

import { describe, expect, test } from "bun:test";
import { authorPrompt, criticPrompt, parseVerdict } from "./prompts.ts";

describe("parseVerdict", () => {
  test("parses a fenced JSON verdict", () => {
    const text =
      'Here you go:\n```json\n{ "done": true, "progress": 90, "feedback": "ship it" }\n```';
    expect(parseVerdict(text, 10)).toEqual({ done: true, progress: 90, feedback: "ship it" });
  });

  test("parses a bare JSON object", () => {
    expect(parseVerdict('{ "done": false, "progress": 42, "feedback": "more" }', 0)).toEqual({
      done: false,
      progress: 42,
      feedback: "more",
    });
  });

  test("clamps progress into 0-100 and rounds", () => {
    expect(parseVerdict('{ "done": false, "progress": 250, "feedback": "" }', 0).progress).toBe(
      100,
    );
    expect(parseVerdict('{ "done": false, "progress": -5, "feedback": "" }', 0).progress).toBe(0);
    expect(parseVerdict('{ "done": false, "progress": 33.6, "feedback": "" }', 0).progress).toBe(
      34,
    );
  });

  test("a missing progress falls back to the previous progress", () => {
    expect(parseVerdict('{ "done": false, "feedback": "hm" }', 55).progress).toBe(55);
  });

  test("fail-closed: garbage is no-progress, never done", () => {
    for (const garbage of ["not json", "```json\nnope\n```", "[1,2]", "null", '"a string"']) {
      const verdict = parseVerdict(garbage, 30);
      expect(verdict.done).toBe(false);
      expect(verdict.progress).toBe(30);
      expect(verdict.feedback).toBe("unparseable critic verdict");
    }
  });

  test("done must be literally true — truthy strings do not succeed", () => {
    expect(parseVerdict('{ "done": "yes", "progress": 100, "feedback": "" }', 0).done).toBe(false);
  });
});

describe("meta-prompts", () => {
  test("authorPrompt states the objective and demands prompt-only output", () => {
    const prompt = authorPrompt({ goal: "draft a haiku" }, []);
    expect(prompt).toContain("draft a haiku");
    expect(prompt).toContain("ONLY the prompt text");
    expect(prompt).toContain("no iterations yet");
  });

  test("authorPrompt clips an oversized transcript field", () => {
    const long = "x".repeat(5_000);
    const prompt = authorPrompt({ goal: "g" }, [
      {
        index: 1,
        authoredPrompt: long,
        executionSummary: "r",
        verdict: { done: false, progress: 10, feedback: "f" },
      },
    ]);
    expect(prompt.length).toBeLessThan(3_000);
    expect(prompt).toContain("[...]");
  });

  test("criticPrompt demands the fenced JSON verdict shape", () => {
    const prompt = criticPrompt({ goal: "g", successCriteria: "c" }, "p", "r");
    expect(prompt).toContain('"done"');
    expect(prompt).toContain('"progress"');
    expect(prompt).toContain('"feedback"');
    expect(prompt).toContain("Success criteria: c");
  });
});
