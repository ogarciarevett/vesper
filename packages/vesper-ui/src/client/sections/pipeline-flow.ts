/// <reference lib="dom" />
/**
 * The flow canvas (specs/pipeline-flow-editor.md): a Drawflow-backed DAG editor —
 * palette drag-in, dark-glass nodes, output→input edges, pan/zoom. This module
 * owns ONLY the canvas; the editor shell owns state, the inspector, and saving.
 * Edges express "runs after and receives the result"; `levelGraph` (the client
 * restatement of packages/pipelines/custom/graph.ts, same algorithm) turns the
 * DAG back into the doc's staged form and refuses cycles.
 */

import Drawflow from "drawflow";
import { h, injectStyle } from "../shell/section.ts";

/** One dependency edge between step ids. */
export interface FlowEdge {
  readonly from: string;
  readonly to: string;
}

/** The compact node face (full detail lives in the inspector). */
export interface FlowNodeView {
  readonly id: string;
  readonly title: string;
  readonly kind: "prompt" | "pipeline";
  /** Overrides the small uppercase kind tag (e.g. "autonomous" for a loop step). */
  readonly kindLabel?: string;
  readonly badge: string;
}

/** One draggable palette entry; `caption` explains it, `featured` highlights it. */
export interface PaletteEntry {
  readonly key: string;
  readonly label: string;
  readonly caption?: string;
  readonly featured?: boolean;
}

export interface FlowCanvasOptions {
  readonly nodes: readonly FlowNodeView[];
  readonly edges: readonly FlowEdge[];
  readonly positions: Readonly<Record<string, { x: number; y: number }>>;
  /** Palette entries: kind "prompt" or a pipeline target id. */
  readonly palette: readonly PaletteEntry[];
  onSelect(stepId: string | null): void;
  /** A palette entry was dropped/clicked onto the canvas. */
  onAdd(key: string, at: { x: number; y: number }): void;
  onEdgesChange(edges: readonly FlowEdge[]): void;
  onMove(stepId: string, at: { x: number; y: number }): void;
  onRemove(stepId: string): void;
  /** Surfaced when a gesture is refused (cycle). */
  toast(message: string): void;
}

export interface FlowCanvasHandle {
  /** Re-render one node's face after inspector edits. */
  updateNode(view: FlowNodeView): void;
  /** Add a node for a freshly created step and select it. */
  addNode(view: FlowNodeView, at: { x: number; y: number }): void;
  destroy(): void;
}

const STYLE_ID = "pipeline-flow-style";
/**
 * Structural Drawflow CSS (the library's 2 KB sheet, restated) + the dark-glass
 * skin. Curves, handles, and node boxes are ours; geometry classes are theirs.
 */
const STYLE = `
.pf-wrap { display: flex; gap: 12px; min-height: 480px; }
.pf-palette { width: 168px; flex: none; display: flex; flex-direction: column; gap: 8px; }
.pf-palette .pf-item { border: 1px dashed var(--border); border-radius: 10px; padding: 9px 11px;
  font-size: 12.5px; color: var(--ink); background: var(--surface-2); cursor: grab; }
.pf-palette .pf-item:hover { border-color: var(--accent); }
.pf-palette .pf-item.featured { border: 1px solid var(--accent); }
.pf-palette .pf-item .pf-cap { display: block; color: var(--ink-soft); font-size: 12px;
  margin-top: 3px; line-height: 1.4; }
.pf-palette .pf-hint { color: var(--ink-soft); font-size: 12.5px; }
.pf-canvas-host { flex: 1; min-width: 0; border: 1px solid var(--border); border-radius: 14px;
  background:
    radial-gradient(circle, var(--border) 1px, transparent 1px) 0 0 / 22px 22px,
    var(--surface);
  overflow: hidden; height: 520px; position: relative; }
.parent-drawflow { display: flex; overflow: hidden; touch-action: none; }
.pf-canvas-host.parent-drawflow { height: 520px; outline: 0; }
.drawflow { width: 100%; height: 100%; user-select: none; position: relative; perspective: 0; }
.drawflow .parent-node { position: relative; }
.drawflow .drawflow-node { display: flex; align-items: center; position: absolute; z-index: 2;
  width: 200px; min-height: 40px; padding: 0; border-radius: 12px;
  background: var(--surface-2); border: 1px solid var(--border); color: var(--ink);
  box-shadow: 0 8px 24px rgba(0,0,0,0.35); cursor: grab; }
.drawflow .drawflow-node.selected { border-color: var(--accent); box-shadow: 0 0 0 2px var(--accent); }
.drawflow .drawflow-node .inputs, .drawflow .drawflow-node .outputs { width: 0; }
.drawflow .drawflow-node .drawflow_content_node { width: 100%; display: block; }
.drawflow .drawflow-node .input, .drawflow .drawflow-node .output { position: relative;
  width: 14px; height: 14px; background: var(--surface); border: 2px solid var(--ink-soft);
  border-radius: 50%; z-index: 3; cursor: crosshair; }
.drawflow .drawflow-node .input { left: -8px; top: 2px; }
.drawflow .drawflow-node .output { right: -8px; top: 2px; }
.drawflow .drawflow-node .input:hover, .drawflow .drawflow-node .output:hover { border-color: var(--accent); }
.drawflow svg { z-index: 0; position: absolute; overflow: visible !important; }
.drawflow .connection { position: absolute; pointer-events: none; }
.drawflow .connection .main-path { fill: none; stroke-width: 2.5px; stroke: var(--ink-soft);
  pointer-events: all; cursor: pointer; }
.drawflow .connection .main-path:hover, .drawflow .connection .main-path.selected { stroke: var(--accent); }
.drawflow .connection .point { cursor: move; stroke: var(--border); stroke-width: 2; fill: var(--surface); }
.drawflow-delete { position: absolute; display: block; width: 26px; height: 26px; line-height: 26px;
  text-align: center; border-radius: 50%; font-family: inherit; font-size: 13px; z-index: 4;
  background: var(--surface); color: var(--ink); border: 1px solid var(--accent); cursor: pointer; }
.parent-node .drawflow-delete { right: -12px; top: -12px; }
.pf-node { padding: 10px 12px 10px 14px; }
.pf-node .pf-kind { font-size: 10px; text-transform: uppercase; letter-spacing: 0.07em;
  color: var(--ink-soft); display: block; }
.pf-node .pf-title { font-size: 13px; font-weight: 700; display: block; margin-top: 1px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pf-node .pf-badge { font-size: 10.5px; color: var(--ink-soft); display: block; margin-top: 2px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
`;

/**
 * Client restatement of graphToStages' leveling (same algorithm, tested server
 * side): returns each node's 0-based level, or null when the edges contain a
 * cycle. Used to refuse cycle-making connections at gesture time and to
 * serialize the doc's stages.
 */
export function levelGraph(
  ids: readonly string[],
  edges: readonly FlowEdge[],
): ReadonlyMap<string, number> | null {
  const incoming = new Map<string, Set<string>>(ids.map((id) => [id, new Set()]));
  for (const edge of edges) {
    if (edge.from === edge.to) return null;
    incoming.get(edge.to)?.add(edge.from);
  }
  const level = new Map<string, number>();
  let remaining = [...ids];
  while (remaining.length > 0) {
    const ready = remaining.filter((id) =>
      [...(incoming.get(id) ?? [])].every((dep) => level.has(dep)),
    );
    if (ready.length === 0) return null;
    for (const id of ready) {
      const deps = [...(incoming.get(id) ?? [])];
      level.set(id, deps.length === 0 ? 0 : Math.max(...deps.map((d) => level.get(d) ?? 0)) + 1);
    }
    remaining = remaining.filter((id) => !level.has(id));
  }
  return level;
}

function nodeHtml(view: FlowNodeView): string {
  const span = (cls: string, text: string): string => {
    const el = document.createElement("span");
    el.className = cls;
    el.textContent = text;
    return el.outerHTML;
  };
  const kind = view.kindLabel ?? (view.kind === "prompt" ? "prompt" : "pipeline");
  return `<div class="pf-node" tabindex="0" role="button" aria-label="${view.title.replaceAll('"', "&quot;")} — open step settings">${span("pf-kind", kind)}${span("pf-title", view.title)}${span("pf-badge", view.badge)}</div>`;
}

/** Mount the canvas into `host` and wire the Drawflow instance to the options. */
export function createFlowCanvas(host: HTMLElement, options: FlowCanvasOptions): FlowCanvasHandle {
  injectStyle(STYLE_ID, STYLE);

  const palette = h("div", { class: "pf-palette" });
  palette.append(
    h("div", { class: "pf-hint" }, "Drag a step onto the canvas, then wire outputs to inputs."),
  );
  const canvasHost = h("div", { class: "pf-canvas-host" });
  host.append(h("div", { class: "pf-wrap" }, palette, canvasHost));

  const editor = new Drawflow(canvasHost);
  editor.reroute = false;
  editor.editor_mode = "edit";
  editor.start();

  // step id <-> drawflow numeric id
  const byStep = new Map<string, number>();
  const byNode = new Map<number, string>();
  /** Guards programmatic mutations from re-entering the change handlers. */
  let muted = true;

  const currentEdges = (): FlowEdge[] => {
    const edges: FlowEdge[] = [];
    const data = editor.export().drawflow.Home.data as Record<
      string,
      { outputs?: Record<string, { connections: { node: string }[] }> }
    >;
    for (const [nodeId, node] of Object.entries(data)) {
      const from = byNode.get(Number(nodeId));
      if (from === undefined) continue;
      for (const output of Object.values(node.outputs ?? {})) {
        for (const conn of output.connections) {
          const to = byNode.get(Number(conn.node));
          if (to !== undefined) edges.push({ from, to });
        }
      }
    }
    return edges;
  };

  const addNodeInternal = (view: FlowNodeView, at: { x: number; y: number }): void => {
    const nodeId = editor.addNode(
      view.id,
      view.kind === "prompt" ? 1 : 1,
      1,
      at.x,
      at.y,
      "pf-df-node",
      { stepId: view.id },
      nodeHtml(view),
      false,
    ) as number;
    byStep.set(view.id, nodeId);
    byNode.set(nodeId, view.id);
  };

  // ── initial render ────────────────────────────────────────────────────
  for (const view of options.nodes) {
    addNodeInternal(view, options.positions[view.id] ?? { x: 60, y: 60 });
  }
  for (const edge of options.edges) {
    const from = byStep.get(edge.from);
    const to = byStep.get(edge.to);
    if (from !== undefined && to !== undefined) {
      editor.addConnection(from, to, "output_1", "input_1");
    }
  }
  muted = false;

  // ── events ────────────────────────────────────────────────────────────
  editor.on("nodeSelected", (nodeId: number) => {
    options.onSelect(byNode.get(Number(nodeId)) ?? null);
  });
  editor.on("nodeUnselected", () => options.onSelect(null));
  editor.on("nodeMoved", (nodeId: number) => {
    const stepId = byNode.get(Number(nodeId));
    if (stepId === undefined) return;
    const node = editor.getNodeFromId(Number(nodeId)) as { pos_x: number; pos_y: number };
    options.onMove(stepId, { x: node.pos_x, y: node.pos_y });
  });
  editor.on("nodeRemoved", (nodeId: number) => {
    const stepId = byNode.get(Number(nodeId));
    if (stepId === undefined) return;
    byNode.delete(Number(nodeId));
    byStep.delete(stepId);
    if (!muted) {
      options.onRemove(stepId);
      options.onEdgesChange(currentEdges());
    }
  });
  editor.on(
    "connectionCreated",
    (conn: { output_id: string; input_id: string; output_class: string; input_class: string }) => {
      if (muted) return;
      const edges = currentEdges();
      const ids = [...byStep.keys()];
      if (levelGraph(ids, edges) === null) {
        // The new edge made a cycle — refuse it in plain language.
        muted = true;
        editor.removeSingleConnection(
          conn.output_id,
          conn.input_id,
          conn.output_class,
          conn.input_class,
        );
        muted = false;
        options.toast("That connection would loop the flow back on itself — not allowed.");
        return;
      }
      options.onEdgesChange(edges);
    },
  );
  editor.on("connectionRemoved", () => {
    if (!muted) options.onEdgesChange(currentEdges());
  });

  // ── palette drag-in (the reactflow dnd pattern) ───────────────────────
  const dropPoint = (event: DragEvent | MouseEvent): { x: number; y: number } => {
    const rect = canvasHost.getBoundingClientRect();
    const zoom = (editor as unknown as { zoom: number }).zoom || 1;
    const canvasX = (editor as unknown as { canvas_x: number }).canvas_x ?? 0;
    const canvasY = (editor as unknown as { canvas_y: number }).canvas_y ?? 0;
    return {
      x: (event.clientX - rect.left - canvasX) / zoom,
      y: (event.clientY - rect.top - canvasY) / zoom,
    };
  };
  for (const entry of options.palette) {
    const item = h(
      "div",
      {
        class: `pf-item${entry.featured === true ? " featured" : ""}`,
        draggable: "true",
        role: "button",
        tabindex: "0",
        "aria-label":
          entry.caption !== undefined ? `${entry.label} — ${entry.caption}` : entry.label,
      },
      entry.label,
      entry.caption !== undefined ? h("span", { class: "pf-cap" }, entry.caption) : null,
    );
    item.addEventListener("dragstart", (e) => {
      (e as DragEvent).dataTransfer?.setData("text/vesper-step", entry.key);
    });
    // Keyboard/touch fallback: click adds at a free spot (staggered, never stacked).
    const freeSpot = (): { x: number; y: number } => {
      const n = byStep.size;
      return { x: 80 + (n % 5) * 36, y: 80 + (n % 5) * 36 };
    };
    item.addEventListener("click", () => options.onAdd(entry.key, freeSpot()));
    item.addEventListener("keydown", (e) => {
      const key = (e as KeyboardEvent).key;
      if (key === "Enter" || key === " ") {
        e.preventDefault();
        options.onAdd(entry.key, freeSpot());
      }
    });
    palette.append(item);
  }
  // Keyboard path: Tab reaches each node face; Enter/Space opens its inspector.
  canvasHost.setAttribute("role", "application");
  canvasHost.setAttribute("aria-label", "pipeline flow canvas");
  canvasHost.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    const face = (e.target as HTMLElement).closest(".pf-node");
    const parent = face?.closest("[id^=node-]");
    if (parent === null || parent === undefined) return;
    e.preventDefault();
    const numeric = Number(parent.id.slice("node-".length));
    const stepId = byNode.get(numeric);
    if (stepId !== undefined) options.onSelect(stepId);
  });
  canvasHost.addEventListener("dragover", (e) => e.preventDefault());
  canvasHost.addEventListener("drop", (e) => {
    e.preventDefault();
    const key = e.dataTransfer?.getData("text/vesper-step");
    if (key !== undefined && key.length > 0) options.onAdd(key, dropPoint(e));
  });

  return {
    addNode(view, at): void {
      muted = true;
      addNodeInternal(view, at);
      muted = false;
    },
    updateNode(view): void {
      const nodeId = byStep.get(view.id);
      if (nodeId === undefined) return;
      const content = canvasHost.querySelector(`#node-${nodeId} .drawflow_content_node`);
      if (content !== null) content.innerHTML = nodeHtml(view);
    },
    destroy(): void {
      editor.clear();
    },
  };
}
