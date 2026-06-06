/**
 * Tests for prompt builders and the BUILD-output parser.
 */

import { describe, expect, test } from "bun:test";
import type { SpecDoc } from "./parse.ts";
import {
  type BuildFile,
  buildPrompt,
  conventionalCommitMessage,
  parseBuildOutput,
  planPrompt,
  reviewPrompt,
  specPrompt,
} from "./prompts.ts";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function fenced(json: unknown, lang = "json"): string {
  return `\`\`\`${lang}\n${JSON.stringify(json)}\n\`\`\``;
}

const SPEC: SpecDoc = { title: "Add cache layer", body: "Write a caching module." };

// ===========================================================================
// parseBuildOutput — success
// ===========================================================================

describe("parseBuildOutput success", () => {
  test("parses a valid fenced json block with one file", () => {
    const text = fenced({ files: [{ path: "src/a.ts", contents: "export const a = 1;\n" }] });
    const result = parseBuildOutput(text);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.value).toHaveLength(1);
    expect(result.value[0]?.path).toBe("src/a.ts");
    expect(result.value[0]?.contents).toBe("export const a = 1;\n");
  });

  test("trims leading and trailing whitespace from file paths", () => {
    const text = fenced({ files: [{ path: "  src/b.ts  ", contents: "x" }] });
    const result = parseBuildOutput(text);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.value[0]?.path).toBe("src/b.ts");
  });

  test("preserves contents verbatim including newlines and indentation", () => {
    const contents = "line 1\n  line 2\n    line 3\n";
    const text = fenced({ files: [{ path: "src/c.ts", contents }] });
    const result = parseBuildOutput(text);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.value[0]?.contents).toBe(contents);
  });

  test("empty-string contents is allowed (an empty file is valid)", () => {
    const text = fenced({ files: [{ path: "src/empty.ts", contents: "" }] });
    const result = parseBuildOutput(text);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.value[0]?.contents).toBe("");
  });

  test("parses multiple files and preserves order", () => {
    const text = fenced({
      files: [
        { path: "src/a.ts", contents: "a" },
        { path: "src/b.ts", contents: "b" },
      ],
    });
    const result = parseBuildOutput(text);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.value).toHaveLength(2);
    expect(result.value.map((f: BuildFile) => f.path)).toEqual(["src/a.ts", "src/b.ts"]);
  });

  test("drops entries with an empty path while keeping valid ones", () => {
    const text = fenced({
      files: [
        { path: "src/good.ts", contents: "ok" },
        { contents: "no path key" },
        { path: "", contents: "empty path" },
        { path: "  ", contents: "whitespace-only path" },
      ],
    });
    const result = parseBuildOutput(text);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.value).toHaveLength(1);
    expect(result.value[0]?.path).toBe("src/good.ts");
  });

  test("drops entries with non-string contents while keeping valid ones", () => {
    const text = fenced({
      files: [
        { path: "src/good.ts", contents: "ok" },
        { path: "src/bad.ts", contents: 42 },
        { path: "src/bad2.ts", contents: null },
      ],
    });
    const result = parseBuildOutput(text);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.value).toHaveLength(1);
    expect(result.value[0]?.path).toBe("src/good.ts");
  });

  test("accepts a no-language fenced block", () => {
    const json = JSON.stringify({ files: [{ path: "x.ts", contents: "y" }] });
    const text = `\`\`\`\n${json}\n\`\`\``;
    expect(parseBuildOutput(text).ok).toBe(true);
  });
});

// ===========================================================================
// parseBuildOutput — fail-closed
// ===========================================================================

describe("parseBuildOutput fail-closed", () => {
  test("returns ok:false when there is no fenced block", () => {
    const result = parseBuildOutput("just some text with no fences");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected not ok");
    expect(result.error).toContain("no fenced");
  });

  test("returns ok:false when the fenced block contains invalid JSON", () => {
    const result = parseBuildOutput("```json\n{ not valid json }\n```");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected not ok");
    expect(result.error.toLowerCase()).toContain("json");
  });

  test("returns ok:false when the JSON object lacks a files array", () => {
    const result = parseBuildOutput(fenced({ outputs: [] }));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected not ok");
    expect(result.error).toContain("files");
  });

  test("returns ok:false when files is not an array", () => {
    const result = parseBuildOutput(fenced({ files: "not an array" }));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected not ok");
    expect(result.error).toContain("files");
  });

  test("returns ok:false with 'no valid files' message when all entries are malformed", () => {
    const text = fenced({
      files: [
        { path: "", contents: "empty path trimmed away" },
        { contents: "no path key" },
        { path: "x.ts", contents: 99 },
      ],
    });
    const result = parseBuildOutput(text);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected not ok");
    expect(result.error).toContain("no valid files");
  });

  test("returns ok:false with 'no valid files' when files array is empty", () => {
    const result = parseBuildOutput(fenced({ files: [] }));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected not ok");
    expect(result.error).toContain("no valid files");
  });
});

// ===========================================================================
// conventionalCommitMessage
// ===========================================================================

describe("conventionalCommitMessage", () => {
  test("prepends feat: and lowercases the first character of a plain title", () => {
    expect(conventionalCommitMessage({ title: "Add caching layer", body: "b" })).toBe(
      "feat: add caching layer",
    );
  });

  test("lowercases only the first character leaving the rest intact", () => {
    expect(conventionalCommitMessage({ title: "Update README file", body: "b" })).toBe(
      "feat: update README file",
    );
  });

  test("collapses multiple internal spaces in the title", () => {
    expect(conventionalCommitMessage({ title: "Add   extra   spaces", body: "b" })).toBe(
      "feat: add extra spaces",
    );
  });

  test("returns a fix: prefixed title unchanged", () => {
    expect(conventionalCommitMessage({ title: "fix: correct off-by-one", body: "b" })).toBe(
      "fix: correct off-by-one",
    );
  });

  test("returns a feat: prefixed title unchanged", () => {
    expect(conventionalCommitMessage({ title: "feat: add dark mode", body: "b" })).toBe(
      "feat: add dark mode",
    );
  });

  test("returns a feat(scope): prefixed title unchanged", () => {
    expect(conventionalCommitMessage({ title: "feat(auth): add OAuth2", body: "b" })).toBe(
      "feat(auth): add OAuth2",
    );
  });

  test("returns a chore!: breaking title unchanged", () => {
    expect(conventionalCommitMessage({ title: "chore!: drop Node 16", body: "b" })).toBe(
      "chore!: drop Node 16",
    );
  });

  test("returns a refactor: prefixed title unchanged", () => {
    expect(conventionalCommitMessage({ title: "refactor: simplify parser", body: "b" })).toBe(
      "refactor: simplify parser",
    );
  });
});

// ===========================================================================
// specPrompt
// ===========================================================================

describe("specPrompt", () => {
  test("returns a string", () => {
    expect(typeof specPrompt("implement sorting")).toBe("string");
  });

  test("contains the SPEC step keyword", () => {
    expect(specPrompt("add a widget")).toContain("SPEC");
  });

  test("wraps the seed in <<<WISH / WISH>>> fences so it is treated as data", () => {
    const p = specPrompt("my wish text");
    expect(p).toContain("<<<WISH");
    expect(p).toContain("my wish text");
    expect(p).toContain("WISH>>>");
  });

  test("instructs the brain to reply with a fenced json block", () => {
    expect(specPrompt("x")).toContain("```json");
  });
});

// ===========================================================================
// planPrompt
// ===========================================================================

describe("planPrompt", () => {
  test("returns a string containing the spec title", () => {
    expect(planPrompt(SPEC)).toContain(SPEC.title);
  });

  test("returns a string containing the spec body", () => {
    expect(planPrompt(SPEC)).toContain(SPEC.body);
  });

  test("contains the PLAN step keyword", () => {
    expect(planPrompt(SPEC)).toContain("PLAN");
  });

  test("instructs the brain to reply with a fenced json block", () => {
    expect(planPrompt(SPEC)).toContain("```json");
  });
});

// ===========================================================================
// buildPrompt
// ===========================================================================

describe("buildPrompt", () => {
  test("returns a string containing the instruction", () => {
    expect(buildPrompt("write a sorter", ["src/sort.ts"])).toContain("write a sorter");
  });

  test("contains each file path", () => {
    const files = ["src/a.ts", "src/b.ts"];
    const p = buildPrompt("do stuff", files);
    for (const f of files) {
      expect(p).toContain(f);
    }
  });

  test("contains the BUILD sub-agent keyword", () => {
    expect(buildPrompt("x", ["y.ts"])).toContain("BUILD");
  });

  test("instructs the brain to reply with a fenced json block", () => {
    expect(buildPrompt("x", ["y.ts"])).toContain("```json");
  });
});

// ===========================================================================
// reviewPrompt
// ===========================================================================

describe("reviewPrompt", () => {
  test("returns a string containing the spec title", () => {
    expect(reviewPrompt(SPEC, "diff --git a/x b/x")).toContain(SPEC.title);
  });

  test("contains the diff text verbatim", () => {
    const diff = "diff --git a/x.ts b/x.ts\n+export const x = 1;";
    expect(reviewPrompt(SPEC, diff)).toContain(diff);
  });

  test("contains the REVIEW step keyword", () => {
    expect(reviewPrompt(SPEC, "diff")).toContain("REVIEW");
  });
});
