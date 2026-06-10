import { describe, expect, it } from "bun:test";
import { ORCHESTRATION_CONTRACTS } from "../router/contracts.ts";
import { parsePipelineDoc } from "./doc.ts";
import { parsePipelineMarkdown, serializePipelineMarkdown } from "./markdown.ts";

/** A rich raw doc in the canonical form the parser emits (defaults omitted as keys allow). */
function richDoc(): Record<string, unknown> {
  return {
    v: 1,
    name: "Release notes draft",
    description: "Draft and verify release notes",
    orchestrator: {
      enabled: true,
      model: "claude-opus",
      instructions: "Keep it terse.\nAlways cite the diff.",
    },
    sharing: { mode: "piped", memory: true },
    stages: [
      {
        tasks: [
          {
            kind: "prompt",
            id: "seed",
            title: "Seed context",
            prompt: "Gather the latest merged PRs.",
          },
          {
            kind: "prompt",
            id: "draft",
            title: "Draft notes",
            prompt: "Write three bullet release notes for: {{input}}",
            skills: ["writing", "research"],
            command: "/draft",
            cli: "claude",
            model: "gpt",
            after: ["seed"],
          },
        ],
      },
      {
        tasks: [
          {
            kind: "pipeline",
            id: "review",
            title: "Review notes",
            target: "loop",
            prompt: "Review and finalize:\n\n{{stages.1.draft.result}}",
            params: { maxIterations: "5", successCriteria: "final notes returned" },
            model: "claude-opus",
            after: ["draft"],
          },
        ],
      },
    ],
    layout: { draft: { x: 120, y: 80 }, review: { x: 320, y: 160 } },
  };
}

/** A hand-written markdown pipeline exercising both step kinds. */
const HAND_WRITTEN_MD = [
  "---",
  "name: Release notes draft",
  "description: Draft then verify",
  "orchestrator-model: claude-opus",
  "orchestrator-instructions: |",
  "  Keep it terse.",
  "memory: on",
  "---",
  "",
  "# Stage 1",
  "",
  "## draft — Draft notes",
  "- cli: claude",
  "- model: gpt",
  "- skills: writing, research",
  "- at: 120,80",
  "",
  "Write three bullet release notes for: {{input}}",
  "",
  "# Stage 2",
  "",
  "## review — Review notes (pipeline: loop)",
  "- successCriteria: done",
  "- after: draft",
  "",
  "Review and finalize:",
  "",
  "{{stages.1.draft.result}}",
].join("\n");

function parseOk(source: string): Record<string, unknown> {
  const result = parsePipelineMarkdown(source);
  if (!result.ok) throw new Error(`expected ok parse, got: ${result.errors.join(" | ")}`);
  return result.doc;
}

function parseErrors(source: string): readonly string[] {
  const result = parsePipelineMarkdown(source);
  if (result.ok) throw new Error("expected a failed parse");
  return result.errors;
}

describe("round-trip", () => {
  it("serialize(richDoc) parses back to an identical raw doc", () => {
    const doc = richDoc();
    const md = serializePipelineMarkdown(doc);
    expect(parseOk(md)).toEqual(doc);
  });

  it("parse(serialize(parse(md))) is stable for a hand-written document", () => {
    const first = parseOk(HAND_WRITTEN_MD);
    const second = parseOk(serializePipelineMarkdown(first));
    expect(second).toEqual(first);
  });

  it("preserves a prompt body with real list items and a fenced code block verbatim", () => {
    const body = [
      "Intro line.",
      "",
      "- a real list item",
      "- another: with colon",
      "",
      "```ts",
      "const x = 1;",
      "# not a heading",
      "```",
      "",
      "Done.",
    ].join("\n");
    const doc: Record<string, unknown> = {
      v: 1,
      name: "Fidelity",
      description: "",
      orchestrator: { enabled: true },
      sharing: { mode: "piped", memory: false },
      stages: [
        { tasks: [{ kind: "prompt", id: "notes", title: "Notes", prompt: body, cli: "claude" }] },
      ],
    };
    const parsed = parseOk(serializePipelineMarkdown(doc));
    expect(parsed).toEqual(doc);
    const stages = parsed.stages as { tasks: { prompt: string }[] }[];
    expect(stages[0]?.tasks[0]?.prompt).toBe(body);
  });
});

describe("parsePipelineMarkdown", () => {
  it("applies defaults: orchestrator on, memory off, empty description", () => {
    const doc = parseOk(
      ["---", "name: Minimal", "---", "", "# Stage 1", "", "## a — A", "", "hi"].join("\n"),
    );
    expect(doc.name).toBe("Minimal");
    expect(doc.description).toBe("");
    expect(doc.orchestrator).toEqual({ enabled: true });
    expect(doc.sharing).toEqual({ mode: "piped", memory: false });
    expect(Object.hasOwn(doc, "layout")).toBe(false);
  });

  it("accepts -- as the id-title separator and serializes it back as —", () => {
    const doc = parseOk(
      ["---", "name: Dashes", "---", "", "# Stage 1", "", "## a -- Title A", "", "hi"].join("\n"),
    );
    const stages = doc.stages as { tasks: { id: string; title: string }[] }[];
    expect(stages[0]?.tasks[0]?.id).toBe("a");
    expect(stages[0]?.tasks[0]?.title).toBe("Title A");
    expect(serializePipelineMarkdown(doc)).toContain("## a — Title A");
  });

  it("parses orchestrator: off and round-trips it", () => {
    const doc = parseOk(
      [
        "---",
        "name: Off",
        "orchestrator: off",
        "---",
        "",
        "# Stage 1",
        "",
        "## a — A",
        "",
        "hi",
      ].join("\n"),
    );
    expect(doc.orchestrator).toEqual({ enabled: false });
    expect(serializePipelineMarkdown(doc)).toContain("orchestrator: off");
  });

  it("allows an empty prompt body at parse level", () => {
    const doc = parseOk(
      ["---", "name: Empty", "---", "", "# Stage 1", "", "## a — A", "", "## b — B", "", "hi"].join(
        "\n",
      ),
    );
    const stages = doc.stages as { tasks: { id: string; prompt: string }[] }[];
    expect(stages[0]?.tasks[0]?.prompt).toBe("");
    expect(stages[0]?.tasks[1]?.prompt).toBe("hi");
  });

  it("populates step.after and doc.layout from after/at attributes", () => {
    const doc = parseOk(
      [
        "---",
        "name: Layout",
        "---",
        "",
        "# Stage 1",
        "",
        "## a — A",
        "",
        "hi",
        "",
        "## b — B",
        "- after: a",
        "- at: 10,20",
        "",
        "ho",
      ].join("\n"),
    );
    const stages = doc.stages as { tasks: Record<string, unknown>[] }[];
    expect(stages[0]?.tasks[1]?.after).toEqual(["a"]);
    expect(doc.layout).toEqual({ b: { x: 10, y: 20 } });
  });

  it("integration: a parsed document validates through parsePipelineDoc", () => {
    const doc = parseOk(HAND_WRITTEN_MD);
    const validated = parsePipelineDoc(doc, ORCHESTRATION_CONTRACTS);
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;
    expect(validated.doc.name).toBe("Release notes draft");
    expect(validated.doc.orchestrator.model).toBe("claude-opus");
    expect(validated.doc.orchestrator.instructions).toBe("Keep it terse.");
    expect(validated.doc.sharing.memory).toBe(true);
    const review = validated.doc.stages[1]?.tasks[0];
    if (review?.kind !== "pipeline") throw new Error("expected pipeline step");
    expect(review.target).toBe("loop");
    expect(review.params).toEqual({ successCriteria: "done" });
  });
});

describe("fail-closed errors (line-numbered)", () => {
  const expectAllLineNumbered = (errors: readonly string[]): void => {
    expect(errors.length).toBeGreaterThan(0);
    for (const error of errors) expect(error).toMatch(/^line \d+: /);
  };

  it("rejects an unknown frontmatter key", () => {
    const errors = parseErrors(
      ["---", "name: X", "foo: bar", "---", "", "# Stage 1", "", "## a — A", "", "hi"].join("\n"),
    );
    expectAllLineNumbered(errors);
    expect(errors.join(" ")).toContain('line 3: unknown frontmatter key "foo"');
  });

  it("rejects an unknown attribute on a prompt step", () => {
    const errors = parseErrors(
      ["---", "name: X", "---", "", "# Stage 1", "", "## a — A", "- bogus: nope", "", "hi"].join(
        "\n",
      ),
    );
    expectAllLineNumbered(errors);
    expect(errors.join(" ")).toContain('line 8: unknown attribute "bogus"');
  });

  it("rejects contract params on a prompt step", () => {
    const errors = parseErrors(
      [
        "---",
        "name: X",
        "---",
        "",
        "# Stage 1",
        "",
        "## a — A",
        "- successCriteria: done",
        "",
        "hi",
      ].join("\n"),
    );
    expectAllLineNumbered(errors);
    expect(errors.join(" ")).toContain('"successCriteria"');
    expect(errors.join(" ")).toContain("pipeline steps");
  });

  it("rejects a bad step id", () => {
    const errors = parseErrors(
      ["---", "name: X", "---", "", "# Stage 1", "", "## Bad_ID — Title", "", "hi"].join("\n"),
    );
    expectAllLineNumbered(errors);
    expect(errors.join(" ")).toContain('line 7: step id "Bad_ID"');
  });

  it("rejects a step heading before any stage heading", () => {
    const errors = parseErrors(["---", "name: X", "---", "", "## a — A", "", "hi"].join("\n"));
    expectAllLineNumbered(errors);
    expect(errors.join(" ")).toContain('line 5: step heading before any "# Stage" heading');
  });

  it("rejects a body-only file (no frontmatter)", () => {
    const errors = parseErrors(["# Stage 1", "", "## a — A", "", "hi"].join("\n"));
    expectAllLineNumbered(errors);
    expect(errors.join(" ")).toContain('line 1: expected "---" to open frontmatter');
  });

  it("rejects prompt-only attributes on a pipeline step", () => {
    const errors = parseErrors(
      [
        "---",
        "name: X",
        "---",
        "",
        "# Stage 1",
        "",
        "## l — Loop (pipeline: loop)",
        "- cli: claude",
        "",
        "go",
      ].join("\n"),
    );
    expectAllLineNumbered(errors);
    expect(errors.join(" ")).toContain('line 8: "cli" is only valid on prompt steps');
  });

  it("rejects bad on/off values, bad at coordinates, and duplicate keys", () => {
    for (const [source, fragment] of [
      [
        ["---", "name: X", "memory: maybe", "---", "", "# Stage 1", "", "## a — A", "", "hi"].join(
          "\n",
        ),
        'memory must be "on" or "off"',
      ],
      [
        ["---", "name: X", "---", "", "# Stage 1", "", "## a — A", "- at: 12", "", "hi"].join("\n"),
        'at must be "x,y"',
      ],
      [
        ["---", "name: X", "name: Y", "---", "", "# Stage 1", "", "## a — A", "", "hi"].join("\n"),
        'duplicate frontmatter key "name"',
      ],
      [
        [
          "---",
          "name: X",
          "---",
          "",
          "# Stage 1",
          "",
          "## a — A",
          "- model: gpt",
          "- model: gpt",
          "",
          "hi",
        ].join("\n"),
        'duplicate attribute "model"',
      ],
    ] as const) {
      const errors = parseErrors(source);
      expectAllLineNumbered(errors);
      expect(errors.join(" ")).toContain(fragment);
    }
  });

  it("rejects unterminated frontmatter, stray headings, and content outside a step", () => {
    for (const [source, fragment] of [
      [["---", "name: X"].join("\n"), 'frontmatter never closed with "---"'],
      [
        ["---", "name: X", "---", "", "# Other", "", "## a — A", "", "hi"].join("\n"),
        "line 5: unexpected heading",
      ],
      [
        ["---", "name: X", "---", "", "stray text", "", "# Stage 1", "", "## a — A", "", "hi"].join(
          "\n",
        ),
        "line 5: content outside a step",
      ],
    ] as const) {
      const errors = parseErrors(source);
      expectAllLineNumbered(errors);
      expect(errors.join(" ")).toContain(fragment);
    }
  });
});
