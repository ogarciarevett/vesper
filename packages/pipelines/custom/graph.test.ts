import { describe, expect, it } from "bun:test";
import { ORCHESTRATION_CONTRACTS } from "../router/contracts.ts";
import { type PipelineDocStep, parsePipelineDoc } from "./doc.ts";
import { docToGraph, type GraphEdge, graphToStages } from "./graph.ts";

function step(id: string, after?: string[]): PipelineDocStep {
  return {
    kind: "prompt",
    id,
    title: id.toUpperCase(),
    prompt: `do ${id}`,
    skills: [],
    ...(after !== undefined ? { after } : {}),
  };
}

describe("docToGraph", () => {
  it("derives implicit edges from stage order and explicit ones from after", () => {
    const parsed = parsePipelineDoc(
      {
        v: 1,
        name: "G",
        layout: { a: { x: 5, y: 6 } },
        stages: [
          { tasks: [step("a"), step("b")] },
          { tasks: [{ ...step("c"), after: ["a"] }] },
          { tasks: [step("d")] },
        ],
      },
      ORCHESTRATION_CONTRACTS,
    );
    if (!parsed.ok) throw new Error(parsed.errors.join("; "));
    const graph = docToGraph(parsed.doc);

    expect(graph.steps.map((s) => s.id)).toEqual(["a", "b", "c", "d"]);
    // c has explicit after [a]; d (no after) implicitly depends on ALL of stage 2.
    expect(graph.edges).toEqual([
      { from: "a", to: "c" },
      { from: "c", to: "d" },
    ]);
    // Saved layout wins; missing positions are auto-laid out by stage column.
    expect(graph.positions.a).toEqual({ x: 5, y: 6 });
    expect((graph.positions.c?.x ?? 0) > (graph.positions.b?.x ?? 0)).toBe(true);
  });
});

describe("graphToStages", () => {
  it("levels a DAG into parallel stages with explicit sorted after", () => {
    const steps = [step("a"), step("b"), step("c"), step("d")];
    const edges: GraphEdge[] = [
      { from: "a", to: "c" },
      { from: "b", to: "c" },
      { from: "c", to: "d" },
    ];
    const result = graphToStages(steps, edges);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.stages.map((s) => s.tasks.map((t) => t.id))).toEqual([["a", "b"], ["c"], ["d"]]);
    expect(result.stages[1]?.tasks[0]?.after).toEqual(["a", "b"]);
    expect(result.stages[0]?.tasks[0]?.after).toBeUndefined();
  });

  it("round-trips: doc -> graph -> stages reproduces the leveling", () => {
    const parsed = parsePipelineDoc(
      {
        v: 1,
        name: "RT",
        stages: [
          { tasks: [step("a"), step("b")] },
          {
            tasks: [
              { ...step("c"), after: ["a"] },
              { ...step("e"), after: ["b"] },
            ],
          },
        ],
      },
      ORCHESTRATION_CONTRACTS,
    );
    if (!parsed.ok) throw new Error(parsed.errors.join("; "));
    const graph = docToGraph(parsed.doc);
    const releveled = graphToStages(graph.steps, graph.edges);
    if (!releveled.ok) throw new Error(releveled.errors.join("; "));
    expect(releveled.stages.map((s) => s.tasks.map((t) => t.id))).toEqual([
      ["a", "b"],
      ["c", "e"],
    ]);
    // The releveled stages re-validate as a doc.
    const revalidated = parsePipelineDoc(
      { v: 1, name: "RT", stages: releveled.stages },
      ORCHESTRATION_CONTRACTS,
    );
    expect(revalidated.ok).toBe(true);
  });

  it("fails closed on cycles and unknown/self edges", () => {
    const cyc = graphToStages(
      [step("a"), step("b")],
      [
        { from: "a", to: "b" },
        { from: "b", to: "a" },
      ],
    );
    expect(cyc.ok).toBe(false);
    if (!cyc.ok) expect(cyc.errors.join(" ")).toContain("cycle");

    expect(graphToStages([step("a")], [{ from: "ghost", to: "a" }]).ok).toBe(false);
    expect(graphToStages([step("a")], [{ from: "a", to: "a" }]).ok).toBe(false);
  });

  it("disconnected nodes land in stage 1", () => {
    const result = graphToStages([step("a"), step("solo")], []);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.stages).toHaveLength(1);
    expect(result.stages[0]?.tasks.map((t) => t.id)).toEqual(["a", "solo"]);
  });
});
