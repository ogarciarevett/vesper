import { describe, expect, it } from "bun:test";
import { type FlowEdge, levelGraph } from "./pipeline-flow.ts";

describe("levelGraph (client restatement of graphToStages leveling)", () => {
  it("levels a DAG: no deps = 0, otherwise deepest predecessor + 1", () => {
    const edges: FlowEdge[] = [
      { from: "a", to: "c" },
      { from: "b", to: "c" },
      { from: "c", to: "d" },
    ];
    const levels = levelGraph(["a", "b", "c", "d"], edges);
    expect(levels).not.toBeNull();
    expect(levels?.get("a")).toBe(0);
    expect(levels?.get("b")).toBe(0);
    expect(levels?.get("c")).toBe(1);
    expect(levels?.get("d")).toBe(2);
  });

  it("returns null on cycles and self-edges (the connect gesture refusal)", () => {
    expect(
      levelGraph(
        ["a", "b"],
        [
          { from: "a", to: "b" },
          { from: "b", to: "a" },
        ],
      ),
    ).toBeNull();
    expect(levelGraph(["a"], [{ from: "a", to: "a" }])).toBeNull();
  });

  it("disconnected nodes are level 0", () => {
    const levels = levelGraph(["a", "solo"], []);
    expect(levels?.get("solo")).toBe(0);
  });
});
