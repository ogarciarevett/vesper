import { describe, expect, it } from "bun:test";
import { ORCHESTRATION_CONTRACTS } from "../router/contracts.ts";
import {
  deriveCapabilities,
  interpolateResults,
  isValidCustomPipelineId,
  MAX_STAGES,
  MAX_TASKS_PER_STAGE,
  parsePipelineDoc,
} from "./doc.ts";

/** A minimal valid raw doc (one prompt step). */
function rawDoc(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    v: 1,
    name: "Morning brief",
    description: "Summarize my day",
    orchestrator: { enabled: true },
    sharing: { mode: "piped", memory: false },
    stages: [
      {
        tasks: [{ kind: "prompt", id: "draft", title: "Draft", prompt: "Write a brief." }],
      },
    ],
    ...overrides,
  };
}

describe("parsePipelineDoc", () => {
  it("accepts a minimal prompt-step doc and applies defaults", () => {
    const result = parsePipelineDoc(rawDoc(), ORCHESTRATION_CONTRACTS);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.doc.name).toBe("Morning brief");
    expect(result.doc.orchestrator.enabled).toBe(true);
    expect(result.doc.sharing.mode).toBe("piped");
    const step = result.doc.stages[0]?.tasks[0];
    expect(step?.kind).toBe("prompt");
    if (step?.kind !== "prompt") return;
    expect(step.skills).toEqual([]);
  });

  it("fails closed on a wrong version, missing name, or empty stages", () => {
    for (const bad of [
      rawDoc({ v: 2 }),
      rawDoc({ name: " " }),
      rawDoc({ stages: [] }),
      "not an object",
      null,
    ]) {
      const result = parsePipelineDoc(bad, ORCHESTRATION_CONTRACTS);
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.errors.length).toBeGreaterThan(0);
    }
  });

  it("rejects a pipeline step whose target is not a contract key", () => {
    const result = parsePipelineDoc(
      rawDoc({
        stages: [
          {
            tasks: [{ kind: "pipeline", id: "x", title: "X", target: "made-up", prompt: "go" }],
          },
        ],
      }),
      ORCHESTRATION_CONTRACTS,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.join(" ")).toContain("made-up");
  });

  it("rejects unknown params on a pipeline step (explicit, not silently clamped)", () => {
    const result = parsePipelineDoc(
      rawDoc({
        stages: [
          {
            tasks: [
              {
                kind: "pipeline",
                id: "l",
                title: "Loop",
                target: "loop",
                prompt: "objective",
                params: { successCriteria: "done", bogus: "nope" },
              },
            ],
          },
        ],
      }),
      ORCHESTRATION_CONTRACTS,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.join(" ")).toContain("bogus");
  });

  it("accepts a pipeline step with contract-declared params", () => {
    const result = parsePipelineDoc(
      rawDoc({
        stages: [
          { tasks: [{ kind: "prompt", id: "a", title: "A", prompt: "p" }] },
          {
            tasks: [
              {
                kind: "pipeline",
                id: "l",
                title: "Loop",
                target: "loop",
                prompt: "objective",
                params: { successCriteria: "done" },
              },
            ],
          },
        ],
      }),
      ORCHESTRATION_CONTRACTS,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const step = result.doc.stages[1]?.tasks[0];
    if (step?.kind !== "pipeline") throw new Error("expected pipeline step");
    expect(step.target).toBe("loop");
    expect(step.params).toEqual({ successCriteria: "done" });
  });

  it("rejects duplicate step ids across stages", () => {
    const result = parsePipelineDoc(
      rawDoc({
        stages: [
          { tasks: [{ kind: "prompt", id: "same", title: "A", prompt: "p" }] },
          { tasks: [{ kind: "prompt", id: "same", title: "B", prompt: "q" }] },
        ],
      }),
      ORCHESTRATION_CONTRACTS,
    );
    expect(result.ok).toBe(false);
  });

  it("enforces the stage and per-stage task caps", () => {
    const manyStages = Array.from({ length: MAX_STAGES + 1 }, (_, i) => ({
      tasks: [{ kind: "prompt", id: `s${i}`, title: "S", prompt: "p" }],
    }));
    expect(parsePipelineDoc(rawDoc({ stages: manyStages }), ORCHESTRATION_CONTRACTS).ok).toBe(
      false,
    );

    const manyTasks = [
      {
        tasks: Array.from({ length: MAX_TASKS_PER_STAGE + 1 }, (_, i) => ({
          kind: "prompt",
          id: `t${i}`,
          title: "T",
          prompt: "p",
        })),
      },
    ];
    expect(parsePipelineDoc(rawDoc({ stages: manyTasks }), ORCHESTRATION_CONTRACTS).ok).toBe(false);
  });
});

describe("deriveCapabilities", () => {
  it("derives WRITE_STORAGE + CLI_INVOKE for a prompt-only doc", () => {
    const result = parsePipelineDoc(rawDoc(), ORCHESTRATION_CONTRACTS);
    if (!result.ok) throw new Error("expected valid doc");
    const caps = deriveCapabilities(result.doc, ORCHESTRATION_CONTRACTS);
    expect([...caps].sort()).toEqual(["CLI_INVOKE", "WRITE_STORAGE"]);
  });

  it("adds SPAWN_SUBAGENT + the target contract's capabilities for pipeline steps", () => {
    const result = parsePipelineDoc(
      rawDoc({
        stages: [
          {
            tasks: [{ kind: "pipeline", id: "l", title: "L", target: "loop", prompt: "go" }],
          },
        ],
      }),
      ORCHESTRATION_CONTRACTS,
    );
    if (!result.ok) throw new Error("expected valid doc");
    const caps = deriveCapabilities(result.doc, ORCHESTRATION_CONTRACTS);
    expect(caps).toContain("SPAWN_SUBAGENT");
    for (const cap of ORCHESTRATION_CONTRACTS.loop?.capabilities ?? []) {
      expect(caps).toContain(cap);
    }
  });

  it("adds READ_STORAGE when sharing.memory is on", () => {
    const result = parsePipelineDoc(
      rawDoc({ sharing: { mode: "piped", memory: true } }),
      ORCHESTRATION_CONTRACTS,
    );
    if (!result.ok) throw new Error("expected valid doc");
    expect(deriveCapabilities(result.doc, ORCHESTRATION_CONTRACTS)).toContain("READ_STORAGE");
  });
});

describe("interpolateResults", () => {
  it("replaces known placeholders and leaves unknown ones visible", () => {
    const results = new Map([["1.draft", "the draft text"]]);
    expect(
      interpolateResults("Use {{stages.1.draft.result}} and {{stages.9.x.result}}", results),
    ).toBe("Use the draft text and {{stages.9.x.result}}");
  });
});

describe("isValidCustomPipelineId", () => {
  it("accepts kebab-case ids and rejects path/separator abuse", () => {
    expect(isValidCustomPipelineId("morning-brief")).toBe(true);
    expect(isValidCustomPipelineId("a")).toBe(true);
    expect(isValidCustomPipelineId("")).toBe(false);
    expect(isValidCustomPipelineId("Has Spaces")).toBe(false);
    expect(isValidCustomPipelineId("../etc")).toBe(false);
    expect(isValidCustomPipelineId("custom:nested")).toBe(false);
    expect(isValidCustomPipelineId("x".repeat(65))).toBe(false);
  });
});
