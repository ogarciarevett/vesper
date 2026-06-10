import { describe, expect, it } from "bun:test";
import { ORCHESTRATION_CONTRACTS } from "../router/contracts.ts";
import { type PipelineDoc, parsePipelineDoc } from "./doc.ts";
import { buildImprovePrompt, type ImproveModelRow, parseImproveProposal } from "./improve.ts";

const MODELS: readonly ImproveModelRow[] = [
  { id: "claude-opus", cli: "claude", tier: "frontier", passAt1: 0.72, meanCostUsd: 2.1 },
  { id: "gpt", cli: "codex", tier: "frontier", passAt1: 0.7, meanCostUsd: 0.9 },
  { id: "claude-haiku", cli: "claude", tier: "cheap", passAt1: 0.51, meanCostUsd: 0.1 },
];

function doc(): PipelineDoc {
  const parsed = parsePipelineDoc(
    {
      v: 1,
      name: "Test",
      stages: [
        {
          tasks: [
            { kind: "prompt", id: "draft", title: "Draft", prompt: "write stuff" },
            { kind: "prompt", id: "check", title: "Check", prompt: "check it" },
          ],
        },
      ],
    },
    ORCHESTRATION_CONTRACTS,
  );
  if (!parsed.ok) throw new Error("fixture doc invalid");
  return parsed.doc;
}

describe("buildImprovePrompt", () => {
  it("includes the whole doc, the model economics, and the scope clause", () => {
    const prompt = buildImprovePrompt(doc(), ORCHESTRATION_CONTRACTS, MODELS, "draft");
    expect(prompt).toContain('step "draft"');
    expect(prompt).toContain('step "check"');
    expect(prompt).toContain("pass@1-per-dollar");
    expect(prompt).toContain("claude-opus");
    expect(prompt).toContain("~$0.90/task");
    expect(prompt).toContain('ONLY suggest changes for step "draft"');
  });
});

describe("parseImproveProposal", () => {
  const reply = (body: unknown): string => `\`\`\`json\n${JSON.stringify(body)}\n\`\`\``;

  it("keeps suggestions for known steps and drops unknown ids and bogus models", () => {
    const proposal = parseImproveProposal(
      reply({
        steps: [
          { id: "draft", prompt: "## Better\nwrite", model: "gpt", reason: "cheaper frontier" },
          { id: "ghost", prompt: "x", reason: "no such step" },
          { id: "check", model: "made-up-model", cli: "claude", reason: "routing" },
        ],
        warnings: ["no success criteria"],
        notes: "solid",
      }),
      doc(),
      MODELS,
    );
    expect(proposal).not.toBeNull();
    expect(proposal?.steps.map((s) => s.id)).toEqual(["draft", "check"]);
    expect(proposal?.steps[0]?.model).toBe("gpt");
    // the bogus model is stripped but the cli suggestion survives
    expect(proposal?.steps[1]?.model).toBeUndefined();
    expect(proposal?.steps[1]?.cli).toBe("claude");
    expect(proposal?.warnings).toEqual(["no success criteria"]);
  });

  it("enforces scope and validates orchestratorModel against the catalog", () => {
    const proposal = parseImproveProposal(
      reply({
        steps: [
          { id: "draft", prompt: "p", reason: "r" },
          { id: "check", prompt: "q", reason: "r" },
        ],
        orchestratorModel: "claude-opus",
      }),
      doc(),
      MODELS,
      "check",
    );
    expect(proposal?.steps.map((s) => s.id)).toEqual(["check"]);
    expect(proposal?.orchestratorModel).toBe("claude-opus");

    const bogusOrch = parseImproveProposal(
      reply({ steps: [], orchestratorModel: "nope", warnings: [] }),
      doc(),
      MODELS,
    );
    expect(bogusOrch).toBeNull();
  });

  it("returns null on junk", () => {
    expect(parseImproveProposal("not json", doc(), MODELS)).toBeNull();
    expect(parseImproveProposal(reply({ steps: [] }), doc(), MODELS)).toBeNull();
  });
});
