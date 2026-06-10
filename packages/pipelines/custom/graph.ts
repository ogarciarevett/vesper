/**
 * Graph ⟷ stages (specs/pipeline-flow-editor.md): the flow canvas edits a DAG of
 * steps; the interpreter runs staged parallelism. This module is the lossless
 * bridge — edges become `after` dependencies, topological LEVELS become stages
 * (same level = parallel), and node positions ride as `layout`. Library-agnostic:
 * the canvas (Drawflow today) only ever consumes/produces these shapes.
 */

import type { PipelineDoc, PipelineDocStage, PipelineDocStep, StepPosition } from "./doc.ts";

/** One dependency edge: `to` runs after `from` and may use its result. */
export interface GraphEdge {
  readonly from: string;
  readonly to: string;
}

/** The canvas-facing projection of a doc. */
export interface PipelineGraph {
  /** Flat steps in stable (stage, index) order. */
  readonly steps: readonly PipelineDocStep[];
  readonly edges: readonly GraphEdge[];
  /** A position for EVERY step (saved layout, or stage-column auto-layout). */
  readonly positions: Readonly<Record<string, StepPosition>>;
}

/** Auto-layout spacing (stage columns x slot rows). */
const COLUMN_W = 320;
const ROW_H = 160;
const MARGIN = 40;

/**
 * Project a doc onto the canvas. Edges come from explicit `after` when present;
 * a step without `after` in stage N>1 depends on EVERY stage N-1 step — that is
 * exactly what the interpreter's piping makes available to it today.
 */
export function docToGraph(doc: PipelineDoc): PipelineGraph {
  const steps: PipelineDocStep[] = [];
  const edges: GraphEdge[] = [];
  const positions: Record<string, StepPosition> = {};

  doc.stages.forEach((stage, stageIndex) => {
    stage.tasks.forEach((step, slot) => {
      steps.push(step);
      positions[step.id] = doc.layout?.[step.id] ?? {
        x: MARGIN + stageIndex * COLUMN_W,
        y: MARGIN + slot * ROW_H,
      };
      if (step.after !== undefined) {
        for (const from of step.after) edges.push({ from, to: step.id });
      } else if (stageIndex > 0) {
        const previous = doc.stages[stageIndex - 1] as PipelineDocStage;
        for (const from of previous.tasks) edges.push({ from: from.id, to: step.id });
      }
    });
  });

  return { steps, edges, positions };
}

/** Leveling outcome: staged tasks (with explicit `after`), or the cycle/errors. */
export type GraphToStagesResult =
  | { readonly ok: true; readonly stages: readonly PipelineDocStage[] }
  | { readonly ok: false; readonly errors: readonly string[] };

/**
 * Level a DAG into stages: a step with no incoming edges is stage 1; every other
 * step sits one past its deepest predecessor. Same level = parallel. Steps keep
 * their input order within a level (deterministic serialization), and every step
 * with incoming edges gets an explicit, sorted `after`. A cycle fails closed.
 */
export function graphToStages(
  steps: readonly PipelineDocStep[],
  edges: readonly GraphEdge[],
): GraphToStagesResult {
  const errors: string[] = [];
  const ids = new Set(steps.map((s) => s.id));
  for (const edge of edges) {
    if (!ids.has(edge.from)) errors.push(`edge: unknown step "${edge.from}"`);
    if (!ids.has(edge.to)) errors.push(`edge: unknown step "${edge.to}"`);
    if (edge.from === edge.to) errors.push(`edge: "${edge.from}" cannot depend on itself`);
  }
  if (errors.length > 0) return { ok: false, errors };

  const incoming = new Map<string, Set<string>>();
  for (const step of steps) incoming.set(step.id, new Set());
  for (const edge of edges) incoming.get(edge.to)?.add(edge.from);

  // Kahn leveling over the original step order (stable within a level).
  const level = new Map<string, number>();
  let remaining = steps.map((s) => s.id);
  let guard = 0;
  while (remaining.length > 0) {
    guard += 1;
    if (guard > steps.length + 1) break; // cycle — nothing became ready
    const ready = remaining.filter((id) =>
      [...(incoming.get(id) ?? [])].every((dep) => level.has(dep)),
    );
    if (ready.length === 0) break; // cycle
    for (const id of ready) {
      const deps = [...(incoming.get(id) ?? [])];
      const depth = deps.length === 0 ? 0 : Math.max(...deps.map((d) => level.get(d) ?? 0)) + 1;
      level.set(id, depth);
    }
    remaining = remaining.filter((id) => !level.has(id));
  }
  if (remaining.length > 0) {
    return {
      ok: false,
      errors: [`the flow has a cycle through: ${remaining.join(", ")}`],
    };
  }

  const depth = Math.max(0, ...level.values());
  const stages: PipelineDocStage[] = [];
  for (let d = 0; d <= depth; d++) {
    const tasks = steps
      .filter((s) => level.get(s.id) === d)
      .map((s) => {
        const deps = [...(incoming.get(s.id) ?? [])].sort();
        const { after: _drop, ...rest } = s;
        return (deps.length > 0 ? { ...rest, after: deps } : rest) as PipelineDocStep;
      });
    if (tasks.length > 0) stages.push({ tasks });
  }
  return { ok: true, stages };
}
