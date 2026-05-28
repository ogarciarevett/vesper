import { describe, expect, test } from "bun:test";
import { SkillTrainError } from "./errors.ts";
import { buildOptimizerPrompt, parseCandidate } from "./optimizer.ts";
import type { SkillFrontmatter, TrajectoryResult } from "./types.ts";

const REQUIRED: SkillFrontmatter = {
  name: "demo-skill",
  description: "A demo skill. Use when demoing.",
};

const SKILL_BODY = `---
name: demo-skill
description: A demo skill. Use when demoing.
---

# Demo

Do the thing.
`;

const RESULTS: readonly TrajectoryResult[] = [
  {
    taskId: "t-high",
    prompt: "say hello",
    expected: "hello world",
    response: "hello world",
    scorer: "contains",
    score: 1,
  },
  {
    taskId: "t-low",
    prompt: "summarize the file",
    expected: "a concise summary",
    response: "no idea",
    scorer: "judge",
    score: 0,
  },
];

/**
 * Build a candidate SKILL.md from frontmatter fields + body prose. No trailing
 * newline: `parseCandidate` returns trimmed content, so fixtures used as the
 * expected return value must be trimmed too.
 */
function candidate(name: string, description: string, body: string): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}`;
}

const VALID_CANDIDATE = candidate(
  REQUIRED.name,
  REQUIRED.description,
  "# Demo\n\nDo the thing carefully and concisely.",
);

describe("buildOptimizerPrompt", () => {
  const prompt = buildOptimizerPrompt({
    skillBody: SKILL_BODY,
    results: RESULTS,
    meanScore: 0.5,
  });

  test("returns a non-empty string", () => {
    expect(prompt.length).toBeGreaterThan(0);
  });

  test("states the optimizer role", () => {
    expect(prompt).toContain("expert prompt and agent-skill optimizer");
  });

  test("embeds the current skill body", () => {
    expect(prompt).toContain("Do the thing.");
  });

  test("includes the mean score", () => {
    expect(prompt).toContain("0.5");
  });

  test("shows each task's prompt, expected, and response", () => {
    expect(prompt).toContain("say hello");
    expect(prompt).toContain("hello world");
    expect(prompt).toContain("summarize the file");
    expect(prompt).toContain("a concise summary");
    expect(prompt).toContain("no idea");
  });

  test("instructs to preserve the frontmatter", () => {
    expect(prompt).toContain("byte-for-byte identical");
  });

  test("instructs to output a fenced code block", () => {
    expect(prompt).toContain("```markdown");
  });

  test("is deterministic for identical input", () => {
    const again = buildOptimizerPrompt({
      skillBody: SKILL_BODY,
      results: RESULTS,
      meanScore: 0.5,
    });
    expect(again).toBe(prompt);
  });
});

describe("parseCandidate", () => {
  test("extracts from a ```markdown fence when frontmatter matches", () => {
    const text = `Here is my proposal:\n\n\`\`\`markdown\n${VALID_CANDIDATE}\n\`\`\`\n\nDone.`;
    expect(parseCandidate(text, REQUIRED)).toBe(VALID_CANDIDATE);
  });

  test("extracts from a plain ``` fence (no language tag)", () => {
    const text = `\`\`\`\n${VALID_CANDIDATE}\n\`\`\``;
    expect(parseCandidate(text, REQUIRED)).toBe(VALID_CANDIDATE);
  });

  test("falls back to whole text when no fence is present", () => {
    expect(parseCandidate(VALID_CANDIDATE, REQUIRED)).toBe(VALID_CANDIDATE);
  });

  test("throws parse_failed when the candidate has no frontmatter", () => {
    try {
      parseCandidate("just some prose, no frontmatter", REQUIRED);
      throw new Error("expected throw");
    } catch (error) {
      expect(error).toBeInstanceOf(SkillTrainError);
      expect((error as SkillTrainError).reason).toBe("parse_failed");
    }
  });

  test("throws parse_failed when the name differs", () => {
    const wrong = candidate("other-skill", REQUIRED.description, "# X");
    try {
      parseCandidate(wrong, REQUIRED);
      throw new Error("expected throw");
    } catch (error) {
      expect(error).toBeInstanceOf(SkillTrainError);
      expect((error as SkillTrainError).reason).toBe("parse_failed");
    }
  });

  test("throws parse_failed when the description differs", () => {
    const wrong = candidate(REQUIRED.name, "A different description.", "# X");
    try {
      parseCandidate(wrong, REQUIRED);
      throw new Error("expected throw");
    } catch (error) {
      expect(error).toBeInstanceOf(SkillTrainError);
      expect((error as SkillTrainError).reason).toBe("parse_failed");
    }
  });

  test("succeeds when name+description match exactly (body prose changed)", () => {
    const rewritten = candidate(
      REQUIRED.name,
      REQUIRED.description,
      "# Demo\n\nCompletely rewritten body with new guidance.",
    );
    expect(parseCandidate(rewritten, REQUIRED)).toBe(rewritten);
  });
});
