/**
 * Tests for the software-engineer pipeline brain-output parsers.
 *
 * Both parseSpec and parsePlan are fail-closed: they never throw and return a
 * typed error on any malformed input. They never use eval — only JSON.parse on
 * an extracted fenced block.
 */

import { describe, expect, test } from "bun:test";
import { parsePlan, parseSpec } from "./parse.ts";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** Wrap JSON in a fenced block with optional language tag. */
function fenced(json: unknown, lang = "json"): string {
  return `\`\`\`${lang}\n${JSON.stringify(json)}\n\`\`\``;
}

/** Same as fenced() but with CRLF line endings. */
function fencedCrlf(json: unknown): string {
  return `\`\`\`json\r\n${JSON.stringify(json)}\r\n\`\`\``;
}

// ===========================================================================
// parseSpec — success
// ===========================================================================

describe("parseSpec success", () => {
  test("extracts a valid fenced-json spec with title and body", () => {
    const text = fenced({ title: "Build the parser", body: "Write parseSpec and parsePlan." });
    const result = parseSpec(text);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.value.title).toBe("Build the parser");
    expect(result.value.body).toBe("Write parseSpec and parsePlan.");
  });

  test("trims whitespace from title and body", () => {
    const text = fenced({ title: "  Trimmed title  ", body: "\n  Trimmed body\n  " });
    const result = parseSpec(text);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.value.title).toBe("Trimmed title");
    expect(result.value.body).toBe("Trimmed body");
  });

  test("ignores prose before and after the fenced block", () => {
    const text = [
      "Here is my analysis of the task.",
      fenced({ title: "Feature X", body: "Implement feature X end-to-end." }),
      "Let me know if you have questions.",
    ].join("\n");
    const result = parseSpec(text);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.value.title).toBe("Feature X");
  });

  test("accepts an optional language tag on the fence", () => {
    // The FENCE_RE allows any tag (or no tag) — verify both extremes.
    const textNoTag = `\`\`\`\n${JSON.stringify({ title: "T", body: "B" })}\n\`\`\``;
    const textWithTag = fenced({ title: "T", body: "B" }, "json");
    expect(parseSpec(textNoTag).ok).toBe(true);
    expect(parseSpec(textWithTag).ok).toBe(true);
  });

  test("handles CRLF line endings in the fenced block", () => {
    const text = fencedCrlf({ title: "CRLF spec", body: "Body with CRLF." });
    const result = parseSpec(text);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.value.title).toBe("CRLF spec");
    expect(result.value.body).toBe("Body with CRLF.");
  });
});

// ===========================================================================
// parseSpec — fail-closed
// ===========================================================================

describe("parseSpec fail-closed", () => {
  test("returns an error (does not throw) when there is no fenced block", () => {
    const result = parseSpec("Just some prose with no code fence.");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected not ok");
    expect(result.error).toBeTruthy();
  });

  test("returns an error when the fenced block is not valid JSON, and error mentions JSON", () => {
    const result = parseSpec("```json\n{ not valid json }\n```");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected not ok");
    expect(result.error.toLowerCase()).toContain("json");
  });

  test("returns an error when the JSON is an array, not an object", () => {
    const result = parseSpec(fenced([{ title: "T", body: "B" }]));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected not ok");
    expect(result.error).toBeTruthy();
  });

  test("returns an error when title is missing", () => {
    const result = parseSpec(fenced({ body: "Body without title." }));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected not ok");
    expect(result.error).toContain("title");
  });

  test("returns an error when title is an empty string", () => {
    const result = parseSpec(fenced({ title: "", body: "Has body." }));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected not ok");
    expect(result.error).toContain("title");
  });

  test("returns an error when title is whitespace-only (trims to empty)", () => {
    const result = parseSpec(fenced({ title: "   ", body: "Has body." }));
    expect(result.ok).toBe(false);
  });

  test("returns an error when body is missing", () => {
    const result = parseSpec(fenced({ title: "Has title." }));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected not ok");
    expect(result.error).toContain("body");
  });

  test("returns an error when body is an empty string", () => {
    const result = parseSpec(fenced({ title: "Has title.", body: "" }));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected not ok");
    expect(result.error).toContain("body");
  });

  test("returns an error when body is whitespace-only (trims to empty)", () => {
    const result = parseSpec(fenced({ title: "Has title.", body: "\n\t  " }));
    expect(result.ok).toBe(false);
  });

  test("returns an error when title is a non-string type", () => {
    const result = parseSpec(fenced({ title: 42, body: "Body." }));
    expect(result.ok).toBe(false);
  });

  test("returns an error when body is a non-string type", () => {
    const result = parseSpec(fenced({ title: "Title.", body: false }));
    expect(result.ok).toBe(false);
  });
});

// ===========================================================================
// parsePlan — success
// ===========================================================================

describe("parsePlan success", () => {
  test("extracts a valid plan with a single task", () => {
    const plan = {
      tasks: [{ id: "task-1", files: ["src/index.ts"], instruction: "Bootstrap the module." }],
    };
    const result = parsePlan(fenced(plan));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.value.tasks).toHaveLength(1);
    const task = result.value.tasks[0];
    expect(task?.id).toBe("task-1");
    expect(task?.instruction).toBe("Bootstrap the module.");
    expect(task?.files).toEqual(["src/index.ts"]);
  });

  test("extracts a valid plan with multiple tasks and preserves task order", () => {
    const plan = {
      tasks: [
        { id: "a", files: ["a.ts"], instruction: "Do A." },
        { id: "b", files: ["b.ts"], instruction: "Do B." },
        { id: "c", files: ["c.ts"], instruction: "Do C." },
      ],
    };
    const result = parsePlan(fenced(plan));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.value.tasks.map((t) => t.id)).toEqual(["a", "b", "c"]);
  });

  test("preserves files array order within a task", () => {
    const plan = {
      tasks: [{ id: "t1", files: ["z.ts", "a.ts", "m.ts"], instruction: "Multi-file task." }],
    };
    const result = parsePlan(fenced(plan));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.value.tasks[0]?.files).toEqual(["z.ts", "a.ts", "m.ts"]);
  });

  test("trims whitespace from id, instruction, and file paths", () => {
    const plan = {
      tasks: [{ id: "  t1  ", files: ["  src/foo.ts  "], instruction: "  Trimmed.  " }],
    };
    const result = parsePlan(fenced(plan));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    const task = result.value.tasks[0];
    expect(task?.id).toBe("t1");
    expect(task?.instruction).toBe("Trimmed.");
    expect(task?.files[0]).toBe("src/foo.ts");
  });

  test("drops malformed task entries while keeping valid ones", () => {
    const plan = {
      tasks: [
        { id: "good", files: ["src/good.ts"], instruction: "Valid task." },
        { id: "", files: ["src/x.ts"], instruction: "Empty id — dropped." },
        { id: "no-files-key", instruction: "Missing files field — dropped." },
        { id: "bad-files", files: "not-an-array", instruction: "Files not array — dropped." },
        { id: "another-good", files: ["src/b.ts"], instruction: "Also valid." },
        42,
        null,
      ],
    };
    const result = parsePlan(fenced(plan));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.value.tasks).toHaveLength(2);
    expect(result.value.tasks[0]?.id).toBe("good");
    expect(result.value.tasks[1]?.id).toBe("another-good");
  });

  test("drops a task whose files array is empty (zero entries)", () => {
    const plan = {
      tasks: [
        { id: "empty-files", files: [], instruction: "Dropped: no files." },
        { id: "has-files", files: ["src/ok.ts"], instruction: "Kept." },
      ],
    };
    const result = parsePlan(fenced(plan));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.value.tasks).toHaveLength(1);
    expect(result.value.tasks[0]?.id).toBe("has-files");
  });

  test("drops a task whose files array contains only empty strings", () => {
    const plan = {
      tasks: [
        { id: "blank-files", files: ["", "   "], instruction: "Dropped: all blank files." },
        { id: "real-files", files: ["src/ok.ts"], instruction: "Kept." },
      ],
    };
    const result = parsePlan(fenced(plan));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.value.tasks).toHaveLength(1);
    expect(result.value.tasks[0]?.id).toBe("real-files");
  });

  test("accepts an optional language tag on the fence", () => {
    const plan = { tasks: [{ id: "t", files: ["f.ts"], instruction: "I." }] };
    expect(parsePlan(fenced(plan, "json")).ok).toBe(true);
    const noTag = `\`\`\`\n${JSON.stringify(plan)}\n\`\`\``;
    expect(parsePlan(noTag).ok).toBe(true);
  });

  test("handles CRLF line endings in the fenced block", () => {
    const plan = { tasks: [{ id: "t", files: ["a.ts"], instruction: "I." }] };
    const result = parsePlan(fencedCrlf(plan));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.value.tasks[0]?.id).toBe("t");
  });
});

// ===========================================================================
// parsePlan — fail-closed
// ===========================================================================

describe("parsePlan fail-closed", () => {
  test("returns an error (does not throw) when there is no fenced block", () => {
    const result = parsePlan("Just prose, no code fence.");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected not ok");
    expect(result.error).toBeTruthy();
  });

  test("returns an error when the fenced block is not valid JSON, and error mentions JSON", () => {
    const result = parsePlan("```json\n{ not valid }\n```");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected not ok");
    expect(result.error.toLowerCase()).toContain("json");
  });

  test("returns an error when the JSON is an array, not an object", () => {
    const result = parsePlan(fenced([{ id: "t", files: ["f.ts"], instruction: "I." }]));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected not ok");
    expect(result.error).toBeTruthy();
  });

  test("returns an error when tasks field is missing (zero valid tasks)", () => {
    const result = parsePlan(fenced({ description: "no tasks field at all" }));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected not ok");
    expect(result.error).toContain("no valid tasks");
  });

  test("returns an error 'no valid tasks' when all task entries are malformed", () => {
    const plan = {
      tasks: [
        { id: "", files: ["x.ts"], instruction: "Empty id." },
        { id: "t", files: [], instruction: "Empty files." },
        { id: "t2", instruction: "No files key." },
        "not an object",
        99,
      ],
    };
    const result = parsePlan(fenced(plan));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected not ok");
    expect(result.error).toBe("no valid tasks");
  });

  test("returns an error 'no valid tasks' when tasks is an empty array", () => {
    const result = parsePlan(fenced({ tasks: [] }));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected not ok");
    expect(result.error).toBe("no valid tasks");
  });

  test("returns an error when tasks is not an array (zero valid tasks)", () => {
    const result = parsePlan(fenced({ tasks: "not an array" }));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected not ok");
    expect(result.error).toContain("no valid tasks");
  });

  test("returns an error when instruction is missing from a task and it is the only task", () => {
    const result = parsePlan(fenced({ tasks: [{ id: "t", files: ["a.ts"] }] }));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected not ok");
    expect(result.error).toContain("no valid tasks");
  });
});
