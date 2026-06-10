/**
 * Prompt catalog (specs/markdown-pipelines.md section 4): the built-in pipelines
 * expose their REAL prompts as read-only `{ name, template }` catalogs. The
 * templates must be the genuine builder output over `{{...}}` placeholders —
 * never a paraphrase — so the spot-checks below call the actual builders with
 * the same placeholder args and compare.
 */

import { describe, expect, test } from "bun:test";
import { authorPrompt, criticPrompt } from "@vesper/core";
import {
  ORCHESTRATION_CONTRACTS,
  type PipelinePrompt,
  pipelinePrompts,
  ROUTE_ALLOWLIST,
} from "./index.ts";
import { buildAnswerPrompt, buildClassifyPrompt } from "./router/handler.ts";
import { buildPlanPrompt } from "./router/plan.ts";
import { SELFTEST_PROBE_PROMPT } from "./selftest/handler.ts";
import { buildPrompt, planPrompt, reviewPrompt, specPrompt } from "./software-engineer/prompts.ts";

function byName(prompts: readonly PipelinePrompt[], name: string): string {
  const entry = prompts.find((p) => p.name === name);
  expect(entry).toBeDefined();
  return entry?.template ?? "";
}

describe("pipelinePrompts — read-only catalogs of the real built-in prompts", () => {
  test("router exposes classify/answer/plan/step-revision as the genuine builder text", () => {
    const prompts = pipelinePrompts("router");
    expect(prompts.length).toBeGreaterThanOrEqual(4);

    // classify: exactly the real builder over the {{message}} placeholder.
    const classify = byName(prompts, "classify");
    expect(classify).toBe(buildClassifyPrompt("{{message}}", Object.keys(ROUTE_ALLOWLIST)));
    expect(classify).toContain("strict intent classifier");
    expect(classify).toContain("{{message}}");

    // answer: the real grounded-answer prompt over an empty runtime snapshot.
    const answer = byName(prompts, "answer");
    expect(answer).toBe(
      buildAnswerPrompt("{{message}}", { pipelines: [], recentRuns: [], schedules: [] }),
    );
    expect(answer).toContain("You are Vesper, your owner's personal assistant");

    // plan: the real orchestration-plan prompt over the live contract map.
    const plan = byName(prompts, "plan");
    expect(plan).toBe(buildPlanPrompt("{{wish}}", ORCHESTRATION_CONTRACTS));
    expect(plan).toContain("YOU author");
    expect(plan).toContain("{{wish}}");

    // step-revision: the real mid-orchestration re-authoring prompt.
    const revision = byName(prompts, "step-revision");
    expect(revision).toContain("mid-orchestration");
    expect(revision).toContain("{{wish}}");
  });

  test("loop exposes the author + critic meta-prompts (real builders, empty transcript)", () => {
    const prompts = pipelinePrompts("loop");
    expect(byName(prompts, "author")).toBe(authorPrompt({ goal: "{{goal}}" }, []));
    expect(byName(prompts, "author")).toContain("autonomous reasoning loop");
    expect(byName(prompts, "critic")).toBe(
      criticPrompt({ goal: "{{goal}}" }, "{{prompt}}", "{{result}}"),
    );
    expect(byName(prompts, "critic")).toContain("You are the critic");
  });

  test("software-engineer exposes spec/plan/build/review (real builders, placeholder spec)", () => {
    const prompts = pipelinePrompts("software-engineer");
    const spec = { title: "{{title}}", body: "{{body}}" };
    expect(byName(prompts, "spec")).toBe(specPrompt("{{wish}}"));
    expect(byName(prompts, "spec")).toContain("SPEC step");
    expect(byName(prompts, "plan")).toBe(planPrompt(spec));
    expect(byName(prompts, "plan")).toContain("FILE-DISJOINT");
    expect(byName(prompts, "build")).toBe(buildPrompt("{{instruction}}", ["{{file}}"]));
    expect(byName(prompts, "build")).toContain("BUILD sub-agent");
    expect(byName(prompts, "review")).toBe(reviewPrompt(spec, "{{diff}}"));
    expect(byName(prompts, "review")).toContain("REVIEW step");
  });

  test("selftest exposes its probe prompt verbatim", () => {
    const prompts = pipelinePrompts("selftest");
    expect(byName(prompts, "probe")).toBe(SELFTEST_PROBE_PROMPT);
    expect(byName(prompts, "probe")).toContain("self-test pipeline");
  });

  test("an unknown handler id yields an empty catalog", () => {
    expect(pipelinePrompts("unknown")).toEqual([]);
  });
});
