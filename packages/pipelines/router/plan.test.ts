/** Adversarial tests for orchestration-plan parsing (the safety boundary). */

import { describe, expect, test } from "bun:test";
import { ORCHESTRATION_CONTRACTS } from "./contracts.ts";
import {
  buildPlanPrompt,
  buildStepRevisionPrompt,
  parseOrchestrationPlan,
  parseStepRevision,
} from "./plan.ts";

function fenced(plan: unknown): string {
  return `Here is the plan:\n\`\`\`json\n${JSON.stringify(plan)}\n\`\`\``;
}

describe("parseOrchestrationPlan", () => {
  test("accepts a valid two-step plan and preserves order", () => {
    const plan = parseOrchestrationPlan(
      fenced({
        steps: [
          {
            mode: "parallel",
            tasks: [
              {
                pipeline: "loop",
                label: "research",
                prompt: "p1",
                model: null,
                difficulty: "hard",
                params: {},
              },
              {
                pipeline: "selftest",
                label: "probe",
                prompt: "p2",
                model: null,
                difficulty: "easy",
                params: {},
              },
            ],
          },
          {
            mode: "parallel",
            tasks: [
              {
                pipeline: "selftest",
                label: "summarize",
                prompt: "p3",
                model: null,
                difficulty: "easy",
                params: {},
              },
            ],
          },
        ],
        notes: "two stages",
      }),
      ORCHESTRATION_CONTRACTS,
    );
    expect(plan?.steps).toHaveLength(2);
    expect(plan?.steps[0]?.tasks.map((t) => t.label)).toEqual(["research", "probe"]);
    expect(plan?.notes).toBe("two stages");
  });

  test("drops free-form pipeline ids — handler ids never come from model text", () => {
    const plan = parseOrchestrationPlan(
      fenced({
        steps: [
          {
            tasks: [
              { pipeline: "rm -rf /", label: "evil", prompt: "x" },
              { pipeline: "selftest", label: "fine", prompt: "y" },
            ],
          },
        ],
      }),
      ORCHESTRATION_CONTRACTS,
    );
    expect(plan?.steps[0]?.tasks.map((t) => t.pipeline)).toEqual(["selftest"]);
  });

  test("filters params to the contract's paramKeys", () => {
    const plan = parseOrchestrationPlan(
      fenced({
        steps: [
          {
            tasks: [
              {
                pipeline: "loop",
                label: "l",
                prompt: "goal text",
                params: { maxIterations: "3", evil: "yes", goal: "override-attempt" },
              },
            ],
          },
        ],
      }),
      ORCHESTRATION_CONTRACTS,
    );
    expect(plan?.steps[0]?.tasks[0]?.params).toEqual({ maxIterations: "3" });
  });

  test("clamps per-pipeline instances to maxInstances and total to 4", () => {
    const many = Array.from({ length: 8 }, (_, i) => ({
      pipeline: "selftest",
      label: `t${i}`,
      prompt: "p",
    }));
    const plan = parseOrchestrationPlan(
      fenced({ steps: [{ tasks: many }] }),
      ORCHESTRATION_CONTRACTS,
    );
    // selftest's contract allows 3 parallel instances.
    expect(plan?.steps[0]?.tasks).toHaveLength(3);
  });

  test("garbage, missing fence, and empty plans yield null", () => {
    expect(parseOrchestrationPlan("no json here", ORCHESTRATION_CONTRACTS)).toBeNull();
    expect(parseOrchestrationPlan(fenced({ steps: [] }), ORCHESTRATION_CONTRACTS)).toBeNull();
    expect(
      parseOrchestrationPlan(
        fenced({ steps: [{ tasks: [{ pipeline: "nope", prompt: "x" }] }] }),
        ORCHESTRATION_CONTRACTS,
      ),
    ).toBeNull();
    expect(parseOrchestrationPlan("```json\nnot json\n```", ORCHESTRATION_CONTRACTS)).toBeNull();
  });

  test("defaults: difficulty falls back to medium, label to the pipeline id", () => {
    const plan = parseOrchestrationPlan(
      fenced({ steps: [{ tasks: [{ pipeline: "loop", prompt: "p", difficulty: "ultra" }] }] }),
      ORCHESTRATION_CONTRACTS,
    );
    expect(plan?.steps[0]?.tasks[0]?.difficulty).toBe("medium");
    expect(plan?.steps[0]?.tasks[0]?.label).toBe("loop");
  });
});

describe("step revision", () => {
  test("parses a label->prompt map and rejects garbage", () => {
    expect(parseStepRevision('```json\n[{"label":"a","prompt":"new"}]\n```')).toEqual({ a: "new" });
    expect(parseStepRevision("nope")).toBeNull();
    expect(parseStepRevision("```json\n{}\n```")).toBeNull();
  });

  test("the revision prompt carries prior outcomes and next labels", () => {
    const prompt = buildStepRevisionPrompt(
      "build a thing",
      [
        {
          pipeline: "selftest",
          label: "summarize",
          prompt: "old",
          model: null,
          difficulty: "easy",
          params: {},
        },
      ],
      [{ label: "research", status: "succeeded", summary: "found X" }],
    );
    expect(prompt).toContain("found X");
    expect(prompt).toContain("summarize");
  });
});

describe("buildPlanPrompt", () => {
  test("lists only contract pipelines and the hard limits", () => {
    const prompt = buildPlanPrompt("do things", ORCHESTRATION_CONTRACTS);
    expect(prompt).toContain("- loop:");
    expect(prompt).toContain("- software-engineer:");
    expect(prompt).toContain("at most 4 tasks");
    expect(prompt).toContain("do things");
  });
});
