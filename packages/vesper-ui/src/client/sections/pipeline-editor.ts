/// <reference lib="dom" />
/**
 * The pipeline editor (specs/pipeline-flow-editor.md): a drag-and-drop DAG
 * canvas (Drawflow) + a single-node inspector, over the SAME daemon routes
 * `vesper pipeline` uses. The canvas shows compact nodes and edges; the full
 * step form appears only for the selected node — never a wall of text.
 * Edges = "runs after, and receives the result"; levels become the doc's
 * stages on save. Permissions stay DERIVED and are shown twice (live
 * summarizer + plain-language cards at save time). Cross-share ships disabled.
 *
 * Layout follows the document-editor convention: Save lives in the top bar
 * (disabled while the doc is invalid; issues listed beside the canvas), the
 * inspector keeps routing/skills behind one "Advanced" disclosure, and the
 * autonomous loop is a first-class palette step — not a separate section.
 */

import { renderMarkdown } from "../shell/markdown.ts";
import { contextMeta, createModelPicker, type ModelPickerGroup } from "../shell/model-picker.ts";
import { h, injectStyle, type SectionContext } from "../shell/section.ts";
import {
  createFlowCanvas,
  type FlowCanvasHandle,
  type FlowEdge,
  type FlowNodeView,
  levelGraph,
} from "./pipeline-flow.ts";

const STYLE_ID = "sec-pipeline-editor-style";
const STYLE = `
.pe-top { display: flex; align-items: center; gap: 10px; margin-bottom: 14px; flex-wrap: wrap; }
.pe-top input[type=text] { font: inherit; background: var(--surface-2); color: var(--ink);
  border: 1px solid var(--border); border-radius: 10px; padding: 8px 12px; box-sizing: border-box; }
.pe-name { font-size: 17px; font-weight: 700; min-width: 240px; }
.pe-desc { flex: 1; min-width: 260px; font-size: 13px; }
.pe-id { color: var(--ink-soft); font-family: var(--mono); font-size: 12px; }
.pe-layout { display: flex; gap: 16px; align-items: flex-start; }
.pe-main { flex: 1; min-width: 0; }
.pe-side { width: 300px; flex: none; position: sticky; top: 8px; }
.pe-side textarea, .pe-side select, .pe-inspector input[type=text], .pe-inspector select,
.pe-inspector textarea { font: inherit; font-size: 13px; background: var(--surface);
  color: var(--ink); border: 1px solid var(--border); border-radius: 8px; padding: 6px 9px;
  width: 100%; box-sizing: border-box; }
.pe-inspector textarea { font-family: var(--mono); font-size: 12.5px; min-height: 140px; resize: vertical; }
.pe-inspector { border: 1px solid var(--border); border-radius: 14px; background: var(--surface);
  padding: 14px; margin-top: 12px; display: flex; flex-direction: column; gap: 8px; }
.pe-inspector .pe-empty { color: var(--ink-soft); font-size: 13px; }
.pe-row { display: flex; gap: 8px; align-items: center; }
.pe-row > * { flex: 1; }
.pe-row label, .pe-mini { color: var(--ink-soft); font-size: 11.5px; flex: none; }
.pe-tabs { display: flex; gap: 4px; }
.pe-tabs button { font: inherit; font-size: 11.5px; padding: 3px 10px; border-radius: 999px;
  border: 1px solid var(--border); background: var(--surface); color: var(--ink-soft); cursor: pointer; }
.pe-tabs button.on { background: var(--accent-strong, var(--accent)); color: #fff; border-color: var(--accent); }
.pe-preview { font-size: 13.5px; line-height: 1.55; border: 1px dashed var(--border); border-radius: 8px;
  padding: 10px 12px; overflow-wrap: break-word; }
.pe-preview pre { background: var(--surface); border: 1px solid var(--border); border-radius: 8px;
  padding: 8px; overflow: auto; font-size: 12px; }
.pe-preview h1, .pe-preview h2, .pe-preview h3 { margin: 6px 0; }
.pe-suggest { border: 1px solid var(--accent); border-radius: 8px;
  padding: 8px 10px; font-size: 12.5px; display: flex; flex-direction: column; gap: 6px; }
.pe-caps { display: flex; flex-direction: column; gap: 6px; }
.pe-cap { display: flex; gap: 8px; align-items: baseline; font-size: 12.5px; }
.pe-cap code { font-family: var(--mono); font-size: 11px; color: var(--ink-soft); }
.pe-errors { display: none; flex-direction: column; gap: 4px; border: 1px solid var(--danger, #ff9d9d);
  border-radius: 10px; padding: 8px 12px; margin-bottom: 10px; }
.pe-errors.has-errors { display: flex; }
.pe-errors .pe-error { font: inherit; font-size: 12.5px; color: var(--danger, #ff9d9d);
  background: none; border: none; padding: 0; text-align: left; }
.pe-errors button.pe-error { cursor: pointer; text-decoration: underline; }
.pe-top .pe-grow { flex: 1; }
.pe-quiet { display: flex; gap: 10px; align-items: center; margin-top: 22px; padding-top: 12px;
  border-top: 1px solid var(--border); flex-wrap: wrap; }
.pe-quiet .btn { font-size: 12px; padding: 4px 12px; }
.pe-coming { color: var(--ink-soft); font-size: 12px; }
.pe-advanced { border: 1px solid var(--border); border-radius: 8px; padding: 0 10px; }
.pe-advanced summary { cursor: pointer; font-size: 12px; color: var(--ink-soft); padding: 7px 0; }
.pe-advanced[open] { padding-bottom: 10px; }
.pe-advanced .pe-body { display: flex; flex-direction: column; gap: 8px; margin-top: 4px; }
.pe-loop-note { font-size: 12.5px; color: var(--ink-soft); line-height: 1.5; margin: 0; }
.pe-loop-cost { font-family: var(--mono); font-size: 12px; color: var(--ink-soft); }
.pe-view-tabs { display: flex; gap: 4px; margin-bottom: 10px; }
.pe-view-tabs button { font: inherit; font-size: 12px; padding: 5px 14px; border-radius: 999px;
  border: 1px solid var(--border); background: var(--surface); color: var(--ink-soft); cursor: pointer; }
.pe-view-tabs button.on { background: var(--accent-strong, var(--accent)); color: #fff; border-color: var(--accent); }
.pe-md { width: 100%; box-sizing: border-box; min-height: 480px; font-family: var(--mono);
  font-size: 12.5px; background: var(--surface); color: var(--ink); border: 1px solid var(--border);
  border-radius: 14px; padding: 14px; resize: vertical; }
@media (max-width: 920px) {
  .pe-layout { flex-direction: column; }
  .pe-side { width: 100%; position: static; }
}
.pe-modal-back { position: fixed; inset: 0; background: rgba(8, 8, 14, 0.6);
  -webkit-backdrop-filter: blur(4px); backdrop-filter: blur(4px); display: grid; place-items: center; z-index: 60; }
.pe-modal { width: min(560px, 92vw); max-height: 84vh; overflow: auto; background: var(--surface);
  border: 1px solid var(--border); border-radius: 16px; padding: 20px; display: flex;
  flex-direction: column; gap: 12px; }
.pe-modal h2 { margin: 0; font-size: 16px; }
.pe-modal input[type=text] { font: inherit; font-size: 13px; background: var(--surface-2); color: var(--ink);
  border: 1px solid var(--border); border-radius: 8px; padding: 8px 10px; width: 100%; box-sizing: border-box; }
.pe-cap-card { border: 1px solid var(--border); border-radius: 10px; padding: 10px 12px;
  display: flex; flex-direction: column; gap: 2px; }
.pe-cap-card .what { font-weight: 600; font-size: 13.5px; }
.pe-cap-card .why { color: var(--ink-soft); font-size: 12px; }
.pe-skills { display: flex; gap: 6px; flex-wrap: wrap; }
.pe-skill { font-size: 11.5px; border: 1px solid var(--border); border-radius: 999px; padding: 2px 9px;
  cursor: pointer; color: var(--ink-soft); background: var(--surface); }
.pe-skill.on { background: var(--accent-strong, var(--accent)); border-color: var(--accent); color: #fff; }
`;

/** Plain-language capability copy (the editor face of the CLI's labels). */
const CAPABILITY_COPY: Readonly<Record<string, { what: string; why: string }>> = {
  CLI_INVOKE: {
    what: "Talk to your AI helper",
    why: "Prompt steps and the orchestrator run through your own CLI.",
  },
  WRITE_STORAGE: {
    what: "Record its runs",
    why: "Every run is written to Vesper's local database so you can replay it.",
  },
  READ_STORAGE: {
    what: "Read your local Vesper data",
    why: "Used to ground prompts in your semantic memory.",
  },
  SPAWN_SUBAGENT: {
    what: "Start other pipelines",
    why: "Pipeline steps launch the built-in pipeline they name — nothing else.",
  },
  NETWORK_FETCH: { what: "Use the network", why: "Required by a pipeline step it launches." },
  FS_READ: { what: "Read files", why: "Required by a pipeline step it launches." },
  FS_WRITE: { what: "Write files", why: "Required by a pipeline step it launches." },
  PROCESS_RUN: { what: "Run programs", why: "Required by a pipeline step it launches." },
  READ_VAULT: { what: "Read vault secrets", why: "Required by a pipeline step it launches." },
  WRITE_VAULT: { what: "Store vault secrets", why: "Required by a pipeline step it launches." },
};

/**
 * The autonomous (loop) step's plain-language face. The loop pipeline is the
 * one target where Vesper authors every prompt itself, so the inspector trades
 * the generic raw-param form for explained fields plus the cost projection the
 * old standalone Loop section carried (author + execute + critic per round).
 */
const LOOP_TARGET = "loop";
const LOOP_CALLS_PER_ROUND = 3;
const LOOP_DEFAULT_ROUNDS = 8;
const LOOP_MAX_ROUNDS = 50;
const LOOP_PARAM_COPY: Readonly<Record<string, string>> = {
  successCriteria: "Done when (optional)",
  maxIterations: `Stop after how many rounds (default ${LOOP_DEFAULT_ROUNDS})`,
};

interface TargetInfo {
  readonly handlerId: string;
  readonly summary: string;
  readonly paramKeys: readonly string[];
  readonly acceptsModel: boolean;
}

interface ModelsInfo {
  readonly catalog: Readonly<
    Record<string, { readonly cli: string; readonly flag?: string; readonly tier?: string }>
  >;
  readonly clis: readonly string[];
}

/** One live-directory row (`GET /api/models/directory`). */
interface DirectoryRow {
  readonly flag: string;
  readonly provider: string;
  readonly cli: string;
  readonly name: string;
  readonly contextLength?: number;
}

interface StepState {
  kind: "prompt" | "pipeline";
  id: string;
  title: string;
  prompt: string;
  skills: string[];
  command: string;
  cli: string;
  model: string;
  target: string;
  params: Record<string, string>;
}

interface EditorState {
  id: string;
  isNew: boolean;
  name: string;
  description: string;
  orchestratorEnabled: boolean;
  orchestratorModel: string;
  orchestratorInstructions: string;
  memory: boolean;
  /** The DAG the canvas edits; levels become stages on serialize. */
  steps: StepState[];
  edges: FlowEdge[];
  positions: Record<string, { x: number; y: number }>;
}

let stepCounter = 0;
function freshStepId(taken: ReadonlySet<string>): string {
  for (;;) {
    stepCounter += 1;
    const id = `step-${stepCounter}`;
    if (!taken.has(id)) return id;
  }
}

/** Serialize the editor's DAG into a PipelineDoc (levels -> stages, edges -> after). */
export function stateToDoc(state: EditorState): Record<string, unknown> {
  const levels = levelGraph(
    state.steps.map((s) => s.id),
    state.edges,
  );
  const incoming = new Map<string, string[]>();
  for (const edge of state.edges) {
    incoming.set(edge.to, [...(incoming.get(edge.to) ?? []), edge.from]);
  }
  const depth = levels === null ? 0 : Math.max(0, ...levels.values());
  const stages: Record<string, unknown>[] = [];
  for (let d = 0; d <= depth; d++) {
    const tasks = state.steps
      .filter((s) => (levels?.get(s.id) ?? 0) === d)
      .map((step) => {
        const after = [...(incoming.get(step.id) ?? [])].sort();
        const base =
          step.kind === "prompt"
            ? {
                kind: "prompt",
                id: step.id,
                title: step.title,
                prompt: step.prompt,
                ...(step.skills.length > 0 ? { skills: step.skills } : {}),
                ...(step.command.trim().length > 0 ? { command: step.command.trim() } : {}),
                ...(step.cli.length > 0 ? { cli: step.cli } : {}),
                ...(step.model.length > 0 ? { model: step.model } : {}),
              }
            : {
                kind: "pipeline",
                id: step.id,
                title: step.title,
                target: step.target,
                prompt: step.prompt,
                ...(Object.keys(step.params).length > 0 ? { params: step.params } : {}),
                ...(step.model.length > 0 ? { model: step.model } : {}),
              };
        return after.length > 0 ? { ...base, after } : base;
      });
    if (tasks.length > 0) stages.push({ tasks });
  }

  const layout: Record<string, { x: number; y: number }> = {};
  for (const step of state.steps) {
    const at = state.positions[step.id];
    if (at !== undefined) layout[step.id] = { x: Math.round(at.x), y: Math.round(at.y) };
  }

  return {
    v: 1,
    name: state.name,
    description: state.description,
    orchestrator: {
      enabled: state.orchestratorEnabled,
      ...(state.orchestratorModel.length > 0 ? { model: state.orchestratorModel } : {}),
      ...(state.orchestratorInstructions.trim().length > 0
        ? { instructions: state.orchestratorInstructions.trim() }
        : {}),
    },
    sharing: { mode: "piped", memory: state.memory },
    stages,
    ...(Object.keys(layout).length > 0 ? { layout } : {}),
  };
}

/** Auto-layout spacing for docs saved before the canvas existed (stage columns). */
const COLUMN_W = 320;
const ROW_H = 160;
const MARGIN = 40;

/** Hydrate editor state from a saved doc (tolerant — the daemon validated it). */
function docToState(id: string, doc: Record<string, unknown>): EditorState {
  const asObj = (v: unknown): Record<string, unknown> =>
    typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  const orchestrator = asObj(doc.orchestrator);
  const sharing = asObj(doc.sharing);
  const layout = asObj(doc.layout);

  const steps: StepState[] = [];
  const edges: FlowEdge[] = [];
  const positions: Record<string, { x: number; y: number }> = {};
  const stages = Array.isArray(doc.stages) ? doc.stages : [];

  stages.forEach((rawStage, stageIndex) => {
    const stage = asObj(rawStage);
    if (!Array.isArray(stage.tasks)) return;
    stage.tasks.forEach((rawTask, slot) => {
      const t = asObj(rawTask);
      const stepId = typeof t.id === "string" ? t.id : `step-${++stepCounter}`;
      steps.push({
        kind: t.kind === "pipeline" ? "pipeline" : "prompt",
        id: stepId,
        title: typeof t.title === "string" ? t.title : "Step",
        prompt: typeof t.prompt === "string" ? t.prompt : "",
        skills: Array.isArray(t.skills) ? t.skills.filter((s) => typeof s === "string") : [],
        command: typeof t.command === "string" ? t.command : "",
        cli: typeof t.cli === "string" ? t.cli : "",
        model: typeof t.model === "string" ? t.model : "",
        target: typeof t.target === "string" ? t.target : "",
        params: Object.fromEntries(
          Object.entries(asObj(t.params)).filter(
            (entry): entry is [string, string] => typeof entry[1] === "string",
          ),
        ),
      });
      const saved = asObj(layout[stepId]);
      positions[stepId] =
        typeof saved.x === "number" && typeof saved.y === "number"
          ? { x: saved.x, y: saved.y }
          : { x: MARGIN + stageIndex * COLUMN_W, y: MARGIN + slot * ROW_H };
      if (Array.isArray(t.after)) {
        for (const from of t.after) {
          if (typeof from === "string") edges.push({ from, to: stepId });
        }
      } else if (stageIndex > 0) {
        // Implicit piping: no explicit deps means "after the whole previous
        // stage" (the interpreter's actual behavior).
        const prevStage = asObj(stages[stageIndex - 1]);
        if (Array.isArray(prevStage.tasks)) {
          for (const prev of prevStage.tasks) {
            const prevId = asObj(prev).id;
            if (typeof prevId === "string") edges.push({ from: prevId, to: stepId });
          }
        }
      }
    });
  });

  return {
    id,
    isNew: false,
    name: typeof doc.name === "string" ? doc.name : id,
    description: typeof doc.description === "string" ? doc.description : "",
    orchestratorEnabled: orchestrator.enabled !== false,
    orchestratorModel: typeof orchestrator.model === "string" ? orchestrator.model : "",
    orchestratorInstructions:
      typeof orchestrator.instructions === "string" ? orchestrator.instructions : "",
    memory: sharing.memory === true,
    steps,
    edges,
    positions,
  };
}

/** Derive a kebab-case id from the name (mirrors the CLI's slugify). */
function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

function select(
  label: string,
  value: string,
  options: readonly { value: string; label: string }[],
  onChange: (value: string) => void,
): HTMLSelectElement {
  const el = document.createElement("select");
  el.setAttribute("aria-label", label);
  for (const opt of options) {
    const o = document.createElement("option");
    o.value = opt.value;
    o.textContent = opt.label;
    if (opt.value === value) o.selected = true;
    el.append(o);
  }
  el.addEventListener("change", () => onChange(el.value));
  return el;
}

function textInput(
  value: string,
  placeholder: string,
  onInput: (value: string) => void,
): HTMLInputElement {
  const el = document.createElement("input");
  el.type = "text";
  el.value = value;
  el.placeholder = placeholder;
  // The placeholder doubles as the accessible name (phrased as a label).
  el.setAttribute("aria-label", placeholder);
  el.addEventListener("input", () => onInput(el.value));
  return el;
}

/** A modal asking for the out-of-band approval code; resolves the code or null. */
function approvalModal(
  ctx: SectionContext,
  title: string,
  body: HTMLElement,
  confirmLabel: string,
): Promise<string | null> {
  return new Promise((resolve) => {
    const code = textInput("", "approval code from the Vesper terminal", () => {});
    const requestBtn = h("button", { class: "btn", type: "button" }, "Get a code");
    requestBtn.addEventListener("click", () => {
      void ctx.api
        .postJson("/api/approval/request")
        .then(() => {
          ctx.toast("A code was printed in the Vesper daemon terminal — paste it here");
          code.focus();
        })
        .catch((err: unknown) =>
          ctx.toast(err instanceof Error ? err.message : "Failed to request code"),
        );
    });
    const cancel = h("button", { class: "btn", type: "button" }, "Go back");
    const confirm = h("button", { class: "btn primary", type: "button" }, confirmLabel);
    const dialog = h(
      "div",
      { class: "pe-modal", role: "dialog", "aria-modal": "true", "aria-label": title },
      h("h2", {}, title),
      body,
      h("div", { class: "pe-row" }, code, requestBtn),
      h("div", { class: "pe-row" }, cancel, confirm),
    );
    const back = h("div", { class: "pe-modal-back" }, dialog);
    const previousFocus = document.activeElement;
    const close = (value: string | null): void => {
      back.removeEventListener("keydown", onKeydown);
      back.remove();
      if (previousFocus instanceof HTMLElement) previousFocus.focus();
      resolve(value);
    };
    // Escape cancels; Tab is trapped inside the dialog (WCAG 2.4.3).
    const onKeydown = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        e.preventDefault();
        close(null);
        return;
      }
      if (e.key !== "Tab") return;
      const focusables = dialog.querySelectorAll<HTMLElement>("button, input");
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (first === undefined || last === undefined) return;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    back.addEventListener("keydown", onKeydown);
    back.addEventListener("click", (e) => {
      if (e.target === back) close(null);
    });
    cancel.addEventListener("click", () => close(null));
    confirm.addEventListener("click", () => {
      const value = code.value.trim();
      if (value.length === 0) {
        ctx.toast("Enter the approval code first");
        return;
      }
      close(value);
    });
    document.body.append(back);
    code.focus();
  });
}

/** Plain-language capability cards for the save modal. */
function capabilityCards(capabilities: readonly string[]): HTMLElement {
  const wrap = h("div", { class: "pe-caps" });
  for (const cap of capabilities) {
    const copy = CAPABILITY_COPY[cap];
    wrap.append(
      h(
        "div",
        { class: "pe-cap-card" },
        h("span", { class: "what" }, copy?.what ?? cap),
        h("span", { class: "why" }, copy?.why ?? ""),
      ),
    );
  }
  return wrap;
}

export interface PipelineEditorOptions {
  /** Existing pipeline id, or null for a new one. */
  readonly id: string | null;
  /** Start a new pipeline from a preset instead of a blank prompt step. */
  readonly preset?: "autonomous";
  /** Called when the editor closes (back/save/delete). */
  readonly onClose: () => void;
}

/** Mount the editor into `host` (replaces its content until closed). */
export async function openPipelineEditor(
  host: HTMLElement,
  ctx: SectionContext,
  options: PipelineEditorOptions,
): Promise<void> {
  injectStyle(STYLE_ID, STYLE);
  host.replaceChildren();

  // ── data ──────────────────────────────────────────────────────────────
  const [targets, models, skillNames, directory] = await Promise.all([
    ctx.api.getJson<TargetInfo[]>("/api/pipelines/custom/targets").catch(() => []),
    ctx.api
      .getJson<{ catalog: Record<string, { cli: string; flag?: string; tier?: string }> }>(
        "/api/models",
      )
      .then((body) => {
        const clis = [...new Set(Object.values(body.catalog).map((e) => e.cli))];
        return { catalog: body.catalog, clis } satisfies ModelsInfo;
      })
      .catch(() => ({ catalog: {}, clis: [] }) satisfies ModelsInfo),
    ctx.api
      .getJson<Array<{ name: string }>>("/api/skills")
      .then((rows) => rows.map((r) => r.name))
      .catch(() => [] as string[]),
    ctx.api
      .getJson<{ available: boolean; models: DirectoryRow[] }>("/api/models/directory")
      .then((body) => (body.available ? body.models : []))
      .catch(() => [] as DirectoryRow[]),
  ]);

  // Picker groups: the curated catalog first, then the live directory per
  // provider (rows whose flag the catalog already covers are deduped away).
  const catalogFlags = new Set(Object.values(models.catalog).map((e) => e.flag ?? ""));
  const PROVIDER_TITLES: Readonly<Record<string, string>> = {
    anthropic: "Anthropic",
    openai: "OpenAI",
    google: "Google",
  };
  const modelGroups: ModelPickerGroup[] = [
    {
      title: "Vesper catalog",
      entries: Object.entries(models.catalog).map(([id, entry]) => ({
        value: id,
        label: id,
        ...(entry.tier !== undefined ? { meta: entry.tier } : {}),
        cli: entry.cli,
      })),
    },
    ...Object.entries(PROVIDER_TITLES)
      .map(([provider, title]) => ({
        title,
        entries: directory
          .filter((m) => m.provider === provider && !catalogFlags.has(m.flag))
          .map((m) => ({
            value: m.flag,
            label: m.name,
            ...(contextMeta(m.contextLength) !== undefined
              ? { meta: contextMeta(m.contextLength) as string }
              : {}),
            cli: m.cli,
          })),
      }))
      .filter((group) => group.entries.length > 0),
  ].filter((group) => group.entries.length > 0);

  let state: EditorState;
  if (options.id !== null) {
    try {
      const detail = await ctx.api.getJson<{ id: string; doc: Record<string, unknown> }>(
        `/api/pipelines/custom/${encodeURIComponent(options.id)}`,
      );
      state = docToState(detail.id, detail.doc);
    } catch {
      ctx.toast(`could not load "${options.id}"`);
      options.onClose();
      return;
    }
  } else {
    const id = freshStepId(new Set());
    const autonomous = options.preset === "autonomous";
    state = {
      id: "",
      isNew: true,
      name: autonomous ? "My autonomous pipeline" : "My pipeline",
      description: "",
      orchestratorEnabled: true,
      orchestratorModel: "",
      orchestratorInstructions: "",
      memory: false,
      steps: [
        autonomous
          ? {
              kind: "pipeline",
              id,
              title: "Autonomous step",
              prompt: "",
              skills: [],
              command: "",
              cli: "",
              model: "",
              target: LOOP_TARGET,
              params: {},
            }
          : {
              kind: "prompt",
              id,
              title: "New step",
              prompt: "",
              skills: [],
              command: "",
              cli: "",
              model: "",
              target: "",
              params: {},
            },
      ],
      edges: [],
      positions: { [id]: { x: 80, y: 80 } },
    };
  }

  // ── live validation (the capability summarizer) ───────────────────────
  const capsHost = h("div", { class: "pe-caps" });
  // Issues live beside the canvas (not inside the permissions panel) and gate
  // Save, so nobody pays the approval ceremony for a doc the daemon will reject.
  const errorsHost = h("div", { class: "pe-errors", role: "alert" });
  let saveButton: HTMLButtonElement | null = null;
  let lastCapabilities: readonly string[] = [];
  let validateTimer: number | null = null;
  let dirty = false;
  const renderErrors = (errors: readonly string[]): void => {
    errorsHost.replaceChildren();
    errorsHost.classList.toggle("has-errors", errors.length > 0);
    for (const message of errors) {
      const stepRef = state.steps.find((s) => message.includes(s.id));
      if (stepRef === undefined) {
        errorsHost.append(h("span", { class: "pe-error" }, message));
        continue;
      }
      const jump = h("button", { class: "pe-error", type: "button" }, message);
      jump.addEventListener("click", () => renderInspector(stepRef.id));
      errorsHost.append(jump);
    }
    if (saveButton !== null) {
      saveButton.disabled = errors.length > 0;
      saveButton.title = errors.length > 0 ? "Fix the issues listed by the canvas first" : "";
    }
  };
  const revalidate = (): void => {
    dirty = true;
    if (validateTimer !== null) window.clearTimeout(validateTimer);
    validateTimer = window.setTimeout(() => {
      void ctx.api
        .postJson<{ ok: boolean; capabilities: string[]; errors: string[] }>(
          "/api/pipelines/custom/validate",
          { doc: stateToDoc(state) },
        )
        .then((outcome) => {
          lastCapabilities = outcome.capabilities;
          capsHost.replaceChildren();
          for (const cap of outcome.capabilities) {
            const copy = CAPABILITY_COPY[cap];
            capsHost.append(
              h("div", { class: "pe-cap" }, h("span", {}, copy?.what ?? cap), h("code", {}, cap)),
            );
          }
          renderErrors(outcome.ok ? [] : outcome.errors);
        })
        .catch(() => {});
    }, 350);
  };
  ctx.onCleanup(() => {
    if (validateTimer !== null) window.clearTimeout(validateTimer);
  });

  const cliOptions = [
    { value: "", label: "cli: default" },
    ...models.clis.map((c) => ({ value: c, label: `cli: ${c}` })),
  ];

  const nodeView = (step: StepState): FlowNodeView => ({
    id: step.id,
    title: step.title,
    kind: step.kind,
    ...(step.kind === "pipeline" && step.target === LOOP_TARGET ? { kindLabel: "autonomous" } : {}),
    badge:
      step.kind === "pipeline"
        ? step.target === LOOP_TARGET
          ? `writes its own prompts${step.model.length > 0 ? ` · ${step.model}` : ""}`
          : `runs ${step.target}${step.model.length > 0 ? ` · ${step.model}` : ""}`
        : [step.cli, step.model].filter((v) => v.length > 0).join(" · ") || "default routing",
  });

  // ── inspector (the ONLY place a step's full form appears) ─────────────
  const inspector = h("div", { class: "pe-inspector" });
  let canvas: FlowCanvasHandle | null = null;

  function renderInspector(stepId: string | null): void {
    inspector.replaceChildren();
    const step = state.steps.find((s) => s.id === stepId);
    if (step === undefined) {
      inspector.append(
        h(
          "p",
          { class: "pe-empty" },
          "Select a step on the canvas to edit it — or drag a new one in from the left.",
        ),
      );
      return;
    }

    const title = textInput(step.title, "step title", (v) => {
      step.title = v;
      canvas?.updateNode(nodeView(step));
      revalidate();
    });

    const remove = h(
      "button",
      { class: "btn", type: "button", "aria-label": `Remove step ${step.title}` },
      "Remove step",
    );
    remove.addEventListener("click", () => {
      state.steps = state.steps.filter((s) => s !== step);
      state.edges = state.edges.filter((e) => e.from !== step.id && e.to !== step.id);
      delete state.positions[step.id];
      mountCanvas(); // rebuild the canvas without the node
      renderInspector(null);
      revalidate();
    });

    inspector.append(h("div", { class: "pe-row" }, title, remove));

    if (step.kind === "pipeline") {
      const target = targets.find((t) => t.handlerId === step.target) ?? targets[0];
      if (step.target.length === 0 && target !== undefined) step.target = target.handlerId;
      const isLoop = step.target === LOOP_TARGET;
      inspector.append(
        select(
          "pipeline to run",
          step.target,
          targets.map((t) => ({
            value: t.handlerId,
            label:
              t.handlerId === LOOP_TARGET
                ? "autonomous: Vesper writes the prompts"
                : `runs: ${t.handlerId}`,
          })),
          (value) => {
            step.target = value;
            step.params = {};
            if (value === LOOP_TARGET && step.title === `Run ${LOOP_TARGET}`) {
              step.title = "Autonomous step";
            }
            canvas?.updateNode(nodeView(step));
            renderInspector(step.id);
            revalidate();
          },
        ),
      );
      if (isLoop) {
        inspector.append(
          h(
            "p",
            { class: "pe-loop-note" },
            "Vesper writes every prompt itself: each round it authors the next prompt, " +
              "runs it, and a critic checks the progress. It stops when the goal is met, " +
              "when it stalls, or at the round cap — and it can only think " +
              "(no files, network, or messages).",
          ),
        );
      }
      const cost = isLoop ? h("span", { class: "pe-loop-cost", "aria-live": "polite" }, "") : null;
      const updateCost = (): void => {
        if (cost === null) return;
        const raw = Number(step.params.maxIterations);
        const rounds =
          Number.isInteger(raw) && raw > 0 ? Math.min(LOOP_MAX_ROUNDS, raw) : LOOP_DEFAULT_ROUNDS;
        cost.textContent = `up to ~${rounds * LOOP_CALLS_PER_ROUND} calls to your AI helper — your own quota`;
      };
      for (const key of target?.paramKeys ?? []) {
        const label = isLoop ? (LOOP_PARAM_COPY[key] ?? key) : key;
        inspector.append(
          h(
            "div",
            { class: "pe-row" },
            h("label", {}, label),
            textInput(step.params[key] ?? "", isLoop ? label : `optional ${key}`, (v) => {
              if (v.length > 0) step.params[key] = v;
              else delete step.params[key];
              if (key === "maxIterations") updateCost();
              revalidate();
            }),
          ),
        );
      }
      if (cost !== null) {
        updateCost();
        inspector.append(cost);
      }
      if (target?.acceptsModel === true) {
        inspector.append(
          createModelPicker({
            label: "model",
            value: step.model,
            defaultLabel: "model: default",
            groups: modelGroups,
            onChange: (entry) => {
              step.model = entry.value;
              canvas?.updateNode(nodeView(step));
              revalidate();
            },
          }).el,
        );
      }
    } else {
      // Skills, command prefix, and cli/model routing are advanced options the
      // first prompt step never needs — one disclosure with a live summary
      // keeps the inspector to title + prompt by default.
      const advanced = h("details", { class: "pe-advanced" }) as HTMLDetailsElement;
      const advancedSummary = h("summary", {}, "");
      const advancedBody = h("div", { class: "pe-body" });
      const summarize = (): void => {
        const routing =
          [step.cli, step.model].filter((v) => v.length > 0).join(" · ") || "default routing";
        const extras = [
          step.skills.length > 0
            ? `${step.skills.length} skill${step.skills.length === 1 ? "" : "s"}`
            : null,
          step.command.trim().length > 0 ? `command ${step.command.trim()}` : null,
        ].filter((v): v is string => v !== null);
        advancedSummary.textContent = `Advanced — ${[routing, ...extras].join(" · ")}`;
      };
      if (skillNames.length > 0) {
        const chips = h("div", { class: "pe-skills" });
        for (const name of skillNames) {
          const chip = h(
            "button",
            {
              class: `pe-skill ${step.skills.includes(name) ? "on" : ""}`,
              type: "button",
              "aria-pressed": step.skills.includes(name) ? "true" : "false",
            },
            name,
          );
          chip.addEventListener("click", () => {
            step.skills = step.skills.includes(name)
              ? step.skills.filter((s) => s !== name)
              : [...step.skills, name];
            chip.classList.toggle("on");
            chip.setAttribute("aria-pressed", chip.classList.contains("on") ? "true" : "false");
            summarize();
            revalidate();
          });
          chips.append(chip);
        }
        advancedBody.append(h("div", { class: "pe-row" }, h("label", {}, "skills"), chips));
      }
      advancedBody.append(
        h(
          "div",
          { class: "pe-row" },
          textInput(step.command, "command prefix (e.g. /spec) — optional", (v) => {
            step.command = v;
            summarize();
            revalidate();
          }),
        ),
        h(
          "div",
          { class: "pe-row" },
          select("cli", step.cli, cliOptions, (v) => {
            step.cli = v;
            canvas?.updateNode(nodeView(step));
            summarize();
            revalidate();
          }),
          createModelPicker({
            label: "model",
            value: step.model,
            defaultLabel: "model: default",
            groups: modelGroups,
            onChange: (entry) => {
              step.model = entry.value;
              canvas?.updateNode(nodeView(step));
              summarize();
              revalidate();
            },
          }).el,
        ),
      );
      summarize();
      advanced.append(advancedSummary, advancedBody);
      inspector.append(advanced);
    }

    // Prompt editor with Write / Preview tabs (markdown).
    const textarea = document.createElement("textarea");
    textarea.value = step.prompt;
    textarea.setAttribute("aria-label", "step prompt (markdown)");
    textarea.placeholder =
      step.kind === "prompt"
        ? "The prompt (markdown). Reference an incoming step with {{steps.<id>.result}}"
        : step.target === LOOP_TARGET
          ? "What should it work toward? e.g. Draft a launch plan for…"
          : "The prompt delivered to the pipeline this step runs";
    textarea.addEventListener("input", () => {
      step.prompt = textarea.value;
      revalidate();
    });
    const preview = h("div", { class: "pe-preview" });
    preview.style.display = "none";
    const writeTab = h("button", { class: "on", type: "button", "aria-pressed": "true" }, "Write");
    const previewTab = h("button", { type: "button", "aria-pressed": "false" }, "Preview");
    writeTab.addEventListener("click", () => {
      writeTab.classList.add("on");
      writeTab.setAttribute("aria-pressed", "true");
      previewTab.classList.remove("on");
      previewTab.setAttribute("aria-pressed", "false");
      preview.style.display = "none";
      textarea.style.display = "";
    });
    previewTab.addEventListener("click", () => {
      previewTab.classList.add("on");
      previewTab.setAttribute("aria-pressed", "true");
      writeTab.classList.remove("on");
      writeTab.setAttribute("aria-pressed", "false");
      preview.innerHTML = renderMarkdown(step.prompt);
      preview.style.display = "";
      textarea.style.display = "none";
    });

    // Per-step AI suggestion (scoped improve) — proposal only, applied on click.
    const suggestBtn = h("button", { class: "btn", type: "button" }, "AI suggestion");
    const suggestHost = h("div", {});
    suggestBtn.addEventListener("click", () => {
      if (state.isNew) {
        ctx.toast("Save the pipeline once — then Vesper can audit it");
        return;
      }
      suggestBtn.setAttribute("disabled", "");
      suggestBtn.textContent = "Asking Vesper…";
      void ctx.api
        .postJson<{
          steps: Array<{
            id: string;
            prompt?: string;
            cli?: string;
            model?: string;
            reason: string;
          }>;
        }>(`/api/pipelines/custom/${encodeURIComponent(state.id)}/improve`, { scope: step.id })
        .then((proposal) => {
          const suggestion = proposal.steps.find((s) => s.id === step.id);
          if (suggestion === undefined) {
            ctx.toast("Vesper had no suggestion for this step");
            return;
          }
          const apply = h("button", { class: "btn primary", type: "button" }, "Apply");
          apply.addEventListener("click", () => {
            if (suggestion.prompt !== undefined) {
              step.prompt = suggestion.prompt;
              textarea.value = suggestion.prompt;
            }
            if (suggestion.cli !== undefined) step.cli = suggestion.cli;
            if (suggestion.model !== undefined) step.model = suggestion.model;
            canvas?.updateNode(nodeView(step));
            renderInspector(step.id);
            revalidate();
          });
          suggestHost.replaceChildren(
            h(
              "div",
              { class: "pe-suggest" },
              h("span", {}, suggestion.reason),
              suggestion.cli !== undefined || suggestion.model !== undefined
                ? h(
                    "span",
                    { class: "pe-mini" },
                    `routing: ${[suggestion.cli, suggestion.model].filter(Boolean).join(" · ")}`,
                  )
                : null,
              suggestion.prompt !== undefined
                ? h("div", { class: "pe-preview", html: renderMarkdown(suggestion.prompt) })
                : null,
              apply,
            ),
          );
        })
        .catch((err: unknown) =>
          ctx.toast(err instanceof Error ? err.message : "suggestion failed"),
        )
        .finally(() => {
          suggestBtn.removeAttribute("disabled");
          suggestBtn.textContent = "AI suggestion";
        });
    });

    inspector.append(
      h(
        "div",
        { class: "pe-row" },
        h("div", { class: "pe-tabs" }, writeTab, previewTab),
        suggestBtn,
      ),
      textarea,
      preview,
      suggestHost,
    );
  }

  // ── the canvas ────────────────────────────────────────────────────────
  const canvasMount = h("div", {});

  function mountCanvas(): void {
    canvas?.destroy();
    canvasMount.replaceChildren();
    canvas = createFlowCanvas(canvasMount, {
      nodes: state.steps.map(nodeView),
      edges: state.edges,
      positions: state.positions,
      palette: [
        { key: "prompt", label: "Prompt step", caption: "You write the prompt." },
        ...targets
          .filter((t) => t.handlerId === LOOP_TARGET)
          .map(() => ({
            key: `pipeline:${LOOP_TARGET}`,
            label: "Autonomous step",
            caption: "Vesper writes every prompt itself and stops when the goal is met.",
            featured: true,
          })),
        ...targets
          .filter((t) => t.handlerId !== LOOP_TARGET)
          .map((t) => ({ key: `pipeline:${t.handlerId}`, label: `Run ${t.handlerId}` })),
      ],
      onSelect: (stepId) => renderInspector(stepId),
      onAdd: (key, at) => {
        const id = freshStepId(new Set(state.steps.map((s) => s.id)));
        const isPipeline = key.startsWith("pipeline:");
        const targetId = isPipeline ? key.slice("pipeline:".length) : "";
        const step: StepState = {
          kind: isPipeline ? "pipeline" : "prompt",
          id,
          title: isPipeline
            ? targetId === LOOP_TARGET
              ? "Autonomous step"
              : `Run ${targetId}`
            : "New step",
          prompt: "",
          skills: [],
          command: "",
          cli: "",
          model: "",
          target: targetId,
          params: {},
        };
        state.steps.push(step);
        state.positions[id] = at;
        canvas?.addNode(nodeView(step), at);
        renderInspector(id);
        revalidate();
      },
      onEdgesChange: (edges) => {
        state.edges = [...edges];
        revalidate();
      },
      onMove: (stepId, at) => {
        state.positions[stepId] = at;
        revalidate();
      },
      onRemove: (stepId) => {
        state.steps = state.steps.filter((s) => s.id !== stepId);
        state.edges = state.edges.filter((e) => e.from !== stepId && e.to !== stepId);
        delete state.positions[stepId];
        renderInspector(null);
        revalidate();
      },
      toast: (message) => ctx.toast(message),
    });
  }

  // ── the Markdown view (the whole pipeline as ONE document) ────────────
  const mdArea = document.createElement("textarea");
  mdArea.className = "pe-md";
  mdArea.setAttribute("aria-label", "pipeline as markdown");
  mdArea.style.display = "none";
  mdArea.addEventListener("input", () => {
    dirty = true;
  });
  const canvasTab = h("button", { type: "button", class: "on", "aria-pressed": "true" }, "Canvas");
  const mdTab = h("button", { type: "button", "aria-pressed": "false" }, "Markdown");
  const setViewTab = (md: boolean): void => {
    canvasTab.classList.toggle("on", !md);
    canvasTab.setAttribute("aria-pressed", md ? "false" : "true");
    mdTab.classList.toggle("on", md);
    mdTab.setAttribute("aria-pressed", md ? "true" : "false");
  };
  mdTab.addEventListener("click", () => {
    void ctx.api
      .postJson<{ markdown?: string; error?: string }>("/api/pipelines/custom/markdown/serialize", {
        doc: stateToDoc(state),
      })
      .then((body) => {
        if (body.markdown === undefined) {
          ctx.toast(body.error ?? "fix the validation errors first");
          return;
        }
        mdArea.value = body.markdown;
        canvasMount.style.display = "none";
        inspector.style.display = "none";
        mdArea.style.display = "";
        setViewTab(true);
      })
      .catch((err: unknown) => ctx.toast(err instanceof Error ? err.message : "serialize failed"));
  });
  canvasTab.addEventListener("click", () => {
    if (mdArea.style.display === "none") return;
    void ctx.api
      .postJson<{ ok: boolean; doc?: Record<string, unknown>; errors?: string[] }>(
        "/api/pipelines/custom/markdown",
        { source: mdArea.value },
      )
      .then((body) => {
        if (!body.ok || body.doc === undefined) {
          ctx.toast(body.errors?.join("; ") ?? "the markdown is not valid");
          return;
        }
        const hydrated = docToState(state.id, body.doc);
        state.name = hydrated.name;
        state.description = hydrated.description;
        state.orchestratorEnabled = hydrated.orchestratorEnabled;
        state.orchestratorModel = hydrated.orchestratorModel;
        state.orchestratorInstructions = hydrated.orchestratorInstructions;
        state.memory = hydrated.memory;
        state.steps = hydrated.steps;
        state.edges = hydrated.edges;
        state.positions = hydrated.positions;
        nameInput.value = state.name;
        descriptionInput.value = state.description;
        mountCanvas();
        renderInspector(null);
        mdArea.style.display = "none";
        canvasMount.style.display = "";
        inspector.style.display = "";
        setViewTab(false);
        revalidate();
      })
      .catch((err: unknown) => ctx.toast(err instanceof Error ? err.message : "parse failed"));
  });

  // ── sidebar: how it runs + permissions ────────────────────────────────
  const orchestratorModelPicker = createModelPicker({
    label: "orchestrator model",
    value: state.orchestratorModel,
    defaultLabel: "best available",
    groups: modelGroups,
    onChange: (entry) => {
      state.orchestratorModel = entry.value;
      revalidate();
    },
  });
  const orchestratorToggle = h("input", { type: "checkbox" }) as HTMLInputElement;
  orchestratorToggle.checked = state.orchestratorEnabled;
  orchestratorToggle.addEventListener("change", () => {
    state.orchestratorEnabled = orchestratorToggle.checked;
    revalidate();
  });
  const memoryToggle = h("input", { type: "checkbox" }) as HTMLInputElement;
  memoryToggle.checked = state.memory;
  memoryToggle.addEventListener("change", () => {
    state.memory = memoryToggle.checked;
    revalidate();
  });
  const instructions = document.createElement("textarea");
  instructions.value = state.orchestratorInstructions;
  instructions.setAttribute("aria-label", "standing guidance for the orchestrator");
  instructions.placeholder = "standing guidance for the orchestrator (optional)";
  instructions.addEventListener("input", () => {
    state.orchestratorInstructions = instructions.value;
    revalidate();
  });

  const side = h(
    "div",
    { class: "pe-side" },
    h(
      "div",
      { class: "panel" },
      h("div", { class: "panel-title" }, "How it runs"),
      h(
        "p",
        { class: "muted" },
        "Connected steps run in order — an arrow means the next step receives the result. Unconnected steps run at the same time.",
      ),
      h(
        "label",
        { class: "pe-row" },
        orchestratorToggle,
        h(
          "span",
          { class: "pe-mini" },
          "Orchestrator: Vesper rewrites downstream prompts from the results so far",
        ),
      ),
      h(
        "details",
        { class: "pe-advanced" },
        h("summary", {}, "Orchestrator settings"),
        h("div", { class: "pe-body" }, orchestratorModelPicker.el, instructions),
      ),
      h(
        "label",
        { class: "pe-row", style: "margin-top:8px" },
        memoryToggle,
        h("span", { class: "pe-mini" }, "Ground the first steps in your semantic memory"),
      ),
    ),
    h(
      "div",
      { class: "panel" },
      h("div", { class: "panel-title" }, "What this pipeline can touch"),
      h(
        "p",
        { class: "muted" },
        "Derived from the steps — you cannot grant more than the pipeline uses.",
      ),
      capsHost,
    ),
  );

  // ── top bar + footer ──────────────────────────────────────────────────
  const idLabel = h("span", { class: "pe-id" }, state.isNew ? "" : `id: ${state.id}`);
  const nameInput = textInput(state.name, "pipeline name", (v) => {
    state.name = v;
    if (state.isNew) {
      state.id = slugify(v);
      idLabel.textContent = state.id.length > 0 ? `id: ${state.id}` : "";
    }
    revalidate();
  });
  nameInput.className = "pe-name";
  const descriptionInput = textInput(state.description, "what is this pipeline for?", (v) => {
    state.description = v;
    revalidate();
  });
  descriptionInput.className = "pe-desc";

  const back = h("button", { class: "btn", type: "button" }, "← Back");
  back.addEventListener("click", () => {
    if (dirty && !window.confirm("Leave without saving? Your changes will be lost.")) return;
    options.onClose();
  });

  const save = h("button", { class: "btn primary", type: "button" }, "Save pipeline");
  saveButton = save as HTMLButtonElement;
  save.addEventListener("click", () => {
    if (state.isNew) state.id = slugify(state.name);
    if (state.id.length === 0) {
      ctx.toast("Give the pipeline a name first");
      return;
    }
    const body = h(
      "div",
      {},
      h(
        "p",
        { class: "muted" },
        "Saving grants the pipeline exactly these abilities — nothing more:",
      ),
      capabilityCards(lastCapabilities),
    );
    void approvalModal(ctx, `Save "${state.name}"?`, body, "Save pipeline").then((code) => {
      if (code === null) return;
      void ctx.api
        .putJson<{ ok: boolean; errors?: string[] }>(
          `/api/pipelines/custom/${encodeURIComponent(state.id)}`,
          { doc: stateToDoc(state) },
          { "x-vesper-approval": code },
        )
        .then((outcome) => {
          if (!outcome.ok) {
            ctx.toast(outcome.errors?.join("; ") ?? "save failed");
            return;
          }
          ctx.toast("Saved");
          dirty = false;
          options.onClose();
        })
        .catch((err: unknown) => ctx.toast(err instanceof Error ? err.message : "save failed"));
    });
  });

  const improve = h("button", { class: "btn", type: "button" }, "Improve with AI");
  const improveHost = h("div", {});
  improve.addEventListener("click", () => {
    if (state.isNew) {
      ctx.toast("Save the pipeline once — then Vesper can audit it");
      return;
    }
    improve.setAttribute("disabled", "");
    improve.textContent = "Vesper is reading the whole pipeline…";
    void ctx.api
      .postJson<{
        steps: Array<{ id: string; prompt?: string; cli?: string; model?: string; reason: string }>;
        orchestratorModel?: string;
        warnings: string[];
        notes: string;
      }>(`/api/pipelines/custom/${encodeURIComponent(state.id)}/improve`)
      .then((proposal) => {
        const panel = h(
          "div",
          { class: "panel" },
          h("div", { class: "panel-title" }, "Vesper's audit"),
        );
        if (proposal.notes.length > 0) panel.append(h("p", {}, proposal.notes));
        for (const warning of proposal.warnings) {
          panel.append(h("p", { class: "muted" }, `warning: ${warning}`));
        }
        for (const suggestion of proposal.steps) {
          const step = state.steps.find((t) => t.id === suggestion.id);
          if (step === undefined) continue;
          const apply = h("button", { class: "btn", type: "button" }, `Apply to "${step.title}"`);
          apply.addEventListener("click", () => {
            if (suggestion.prompt !== undefined) step.prompt = suggestion.prompt;
            if (suggestion.cli !== undefined) step.cli = suggestion.cli;
            if (suggestion.model !== undefined) step.model = suggestion.model;
            canvas?.updateNode(nodeView(step));
            renderInspector(step.id);
            revalidate();
            ctx.toast(`Applied to "${step.title}" — review and save`);
          });
          panel.append(
            h(
              "div",
              { class: "pe-suggest" },
              h("span", {}, `${step.title}: ${suggestion.reason}`),
              suggestion.prompt !== undefined
                ? h("div", { class: "pe-preview", html: renderMarkdown(suggestion.prompt) })
                : null,
              apply,
            ),
          );
        }
        if (proposal.orchestratorModel !== undefined) {
          const applyOrch = h(
            "button",
            { class: "btn", type: "button" },
            `Orchestrator → ${proposal.orchestratorModel}`,
          );
          applyOrch.addEventListener("click", () => {
            state.orchestratorModel = proposal.orchestratorModel ?? "";
            orchestratorModelPicker.set(state.orchestratorModel);
            revalidate();
          });
          panel.append(applyOrch);
        }
        improveHost.replaceChildren(panel);
        panel.scrollIntoView({
          behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
            ? "auto"
            : "smooth",
          block: "nearest",
        });
      })
      .catch((err: unknown) => ctx.toast(err instanceof Error ? err.message : "improve failed"))
      .finally(() => {
        improve.removeAttribute("disabled");
        improve.textContent = "Improve with AI";
      });
  });

  const del = h("button", { class: "btn", type: "button" }, "Delete pipeline");
  del.addEventListener("click", () => {
    const body = h(
      "p",
      { class: "muted" },
      "The pipeline is archived, never destroyed — saving it again restores it.",
    );
    void approvalModal(ctx, `Delete "${state.name}"?`, h("div", {}, body), "Delete pipeline").then(
      (code) => {
        if (code === null) return;
        // The thin ApiClient has no DELETE helper; a raw same-origin fetch is fine.
        void fetch(`/api/pipelines/custom/${encodeURIComponent(state.id)}`, {
          method: "DELETE",
          headers: { "x-vesper-approval": code },
        })
          .then((res) => {
            if (!res.ok) throw new Error(`delete failed (HTTP ${res.status})`);
            ctx.toast("Archived");
            dirty = false;
            options.onClose();
          })
          .catch((err: unknown) => ctx.toast(err instanceof Error ? err.message : "delete failed"));
      },
    );
  });

  const crossShare = h(
    "button",
    { class: "btn", type: "button", disabled: true, title: "Share via cross-ai — coming soon" },
    "Cross-share",
  );

  const main = h(
    "div",
    { class: "pe-main" },
    h(
      "div",
      { class: "pe-view-tabs", role: "group", "aria-label": "editor view" },
      canvasTab,
      mdTab,
    ),
    errorsHost,
    canvasMount,
    mdArea,
    inspector,
  );
  // Save lives in the top bar (the document-editor convention); the quiet row
  // at the very bottom holds only the rare intents, away from the commit action.
  host.append(
    h(
      "div",
      { class: "pe-top" },
      back,
      nameInput,
      idLabel,
      h("span", { class: "pe-grow" }),
      improve,
      save,
    ),
    h("div", { class: "pe-top" }, descriptionInput),
    h("div", { class: "pe-layout" }, main, side),
    improveHost,
    h(
      "div",
      { class: "pe-quiet" },
      state.isNew ? null : del,
      crossShare,
      h("span", { class: "pe-coming" }, "coming soon"),
    ),
  );
  mountCanvas();
  renderInspector(state.steps[0]?.id ?? null);
  revalidate();
  dirty = false;
}
