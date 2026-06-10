/// <reference lib="dom" />
/**
 * The pipeline editor (specs/pipeline-editor.md): a staged rail — stages run in
 * order, the cards inside a stage run in parallel — over the SAME daemon routes
 * `vesper pipeline` uses. Deliberately NOT a node graph: add/remove/reorder is
 * the whole gesture set. Permissions are DERIVED and shown twice (the live
 * "what this pipeline can touch" summarizer + plain-language cards at save time,
 * impeccable's progressive-disclosure pattern). Cross-share ships disabled.
 */

import { renderMarkdown } from "../shell/markdown.ts";
import { h, injectStyle, type SectionContext } from "../shell/section.ts";

const STYLE_ID = "sec-pipeline-editor-style";
const STYLE = `
.pe-top { display: flex; align-items: center; gap: 10px; margin-bottom: 14px; flex-wrap: wrap; }
.pe-top input[type=text] { font: inherit; background: var(--surface-2); color: var(--ink);
  border: 1px solid var(--border); border-radius: 10px; padding: 8px 12px; box-sizing: border-box; }
.pe-name { font-size: 17px; font-weight: 700; min-width: 240px; }
.pe-desc { flex: 1; min-width: 260px; font-size: 13px; }
.pe-id { color: var(--ink-soft); font-family: var(--mono); font-size: 12px; }
.pe-layout { display: flex; gap: 16px; align-items: flex-start; }
.pe-rail { flex: 1; min-width: 0; }
.pe-side { width: 300px; flex: none; position: sticky; top: 8px; }
.pe-stage { border: 1px solid var(--border); border-radius: 14px; padding: 12px; margin-bottom: 18px;
  background: var(--surface); position: relative; }
.pe-stage + .pe-stage::before { content: ""; position: absolute; top: -19px; left: 28px; width: 2px;
  height: 18px; background: var(--border); }
.pe-stage-head { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; }
.pe-stage-head .t { font-weight: 700; font-size: 13px; }
.pe-stage-head .hint { color: var(--ink-soft); font-size: 12px; }
.pe-cards { display: flex; gap: 12px; flex-wrap: wrap; }
.pe-card { flex: 1 1 320px; min-width: 280px; border: 1px solid var(--border); border-radius: 12px;
  padding: 12px; background: var(--surface-2); display: flex; flex-direction: column; gap: 8px; }
.pe-card input[type=text], .pe-card select, .pe-card textarea, .pe-side textarea, .pe-side select {
  font: inherit; font-size: 13px; background: var(--surface); color: var(--ink);
  border: 1px solid var(--border); border-radius: 8px; padding: 6px 9px; width: 100%; box-sizing: border-box; }
.pe-card textarea { font-family: var(--mono); font-size: 12.5px; min-height: 110px; resize: vertical; }
.pe-row { display: flex; gap: 8px; align-items: center; }
.pe-row > * { flex: 1; }
.pe-row label, .pe-mini { color: var(--ink-soft); font-size: 11.5px; flex: none; }
.pe-tabs { display: flex; gap: 4px; }
.pe-tabs button { font: inherit; font-size: 11.5px; padding: 3px 10px; border-radius: 999px;
  border: 1px solid var(--border); background: var(--surface); color: var(--ink-soft); cursor: pointer; }
.pe-tabs button.on { background: var(--accent); color: #fff; border-color: var(--accent); }
.pe-preview { font-size: 13.5px; line-height: 1.55; border: 1px dashed var(--border); border-radius: 8px;
  padding: 10px 12px; overflow-wrap: break-word; }
.pe-preview pre { background: var(--surface); border: 1px solid var(--border); border-radius: 8px;
  padding: 8px; overflow: auto; font-size: 12px; }
.pe-preview h1, .pe-preview h2, .pe-preview h3 { margin: 6px 0; }
.pe-suggest { border: 1px solid var(--border); border-left: 3px solid var(--accent); border-radius: 8px;
  padding: 8px 10px; font-size: 12.5px; display: flex; flex-direction: column; gap: 6px; }
.pe-caps { display: flex; flex-direction: column; gap: 6px; }
.pe-cap { display: flex; gap: 8px; align-items: baseline; font-size: 12.5px; }
.pe-cap code { font-family: var(--mono); font-size: 11px; color: var(--ink-soft); }
.pe-errors { color: #ff9d9d; font-size: 12.5px; white-space: pre-wrap; }
.pe-footer { display: flex; gap: 10px; align-items: center; margin-top: 16px; flex-wrap: wrap; }
.pe-coming { color: var(--ink-soft); font-size: 11.5px; }
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
.pe-skill.on { background: var(--accent); border-color: var(--accent); color: #fff; }
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

interface TargetInfo {
  readonly handlerId: string;
  readonly summary: string;
  readonly paramKeys: readonly string[];
  readonly acceptsModel: boolean;
}

interface ModelsInfo {
  readonly catalogIds: readonly string[];
  readonly clis: readonly string[];
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

interface StageState {
  tasks: StepState[];
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
  stages: StageState[];
}

let stepCounter = 0;
function freshStep(targets: readonly TargetInfo[]): StepState {
  stepCounter += 1;
  return {
    kind: "prompt",
    id: `step-${stepCounter}`,
    title: "New step",
    prompt: "",
    skills: [],
    command: "",
    cli: "",
    model: "",
    target: targets[0]?.handlerId ?? "",
    params: {},
  };
}

/** Serialize the editor state into a PipelineDoc the daemon validates. */
export function stateToDoc(state: EditorState): Record<string, unknown> {
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
    stages: state.stages.map((stage) => ({
      tasks: stage.tasks.map((step) =>
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
            },
      ),
    })),
  };
}

/** Hydrate editor state from a saved doc (tolerant — the daemon already validated it). */
function docToState(id: string, doc: Record<string, unknown>): EditorState {
  const asObj = (v: unknown): Record<string, unknown> =>
    typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  const orchestrator = asObj(doc.orchestrator);
  const sharing = asObj(doc.sharing);
  const stages: StageState[] = [];
  if (Array.isArray(doc.stages)) {
    for (const rawStage of doc.stages) {
      const stage = asObj(rawStage);
      const tasks: StepState[] = [];
      if (Array.isArray(stage.tasks)) {
        for (const rawTask of stage.tasks) {
          const t = asObj(rawTask);
          tasks.push({
            kind: t.kind === "pipeline" ? "pipeline" : "prompt",
            id: typeof t.id === "string" ? t.id : `step-${++stepCounter}`,
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
        }
      }
      stages.push({ tasks });
    }
  }
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
    stages,
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
  // The placeholder doubles as the accessible name (every call site phrases it
  // as a label, not an example value).
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
    // Clicking the dimmed backdrop (not the dialog) cancels.
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
  const [targets, models, skillNames] = await Promise.all([
    ctx.api.getJson<TargetInfo[]>("/api/pipelines/custom/targets").catch(() => []),
    ctx.api
      .getJson<{ catalog: Record<string, { cli: string }> }>("/api/models")
      .then((body) => {
        const catalogIds = Object.keys(body.catalog);
        const clis = [...new Set(Object.values(body.catalog).map((e) => e.cli))];
        return { catalogIds, clis } satisfies ModelsInfo;
      })
      .catch(() => ({ catalogIds: [], clis: [] }) satisfies ModelsInfo),
    ctx.api
      .getJson<Array<{ name: string }>>("/api/skills")
      .then((rows) => rows.map((r) => r.name))
      .catch(() => [] as string[]),
  ]);

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
    state = {
      id: "",
      isNew: true,
      name: "My pipeline",
      description: "",
      orchestratorEnabled: true,
      orchestratorModel: "",
      orchestratorInstructions: "",
      memory: false,
      stages: [{ tasks: [freshStep(targets)] }],
    };
  }

  // ── live validation (the capability summarizer) ───────────────────────
  const capsHost = h("div", { class: "pe-caps" });
  const errorsHost = h("div", { class: "pe-errors" });
  let lastCapabilities: readonly string[] = [];
  let validateTimer: number | null = null;
  let dirty = false;
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
          errorsHost.textContent = outcome.ok ? "" : outcome.errors.join("\n");
        })
        .catch(() => {});
    }, 350);
  };
  ctx.onCleanup(() => {
    if (validateTimer !== null) window.clearTimeout(validateTimer);
  });

  // ── step card ─────────────────────────────────────────────────────────
  const modelOptions = [
    { value: "", label: "model: default" },
    ...models.catalogIds.map((id) => ({ value: id, label: `model: ${id}` })),
  ];
  const cliOptions = [
    { value: "", label: "cli: default" },
    ...models.clis.map((c) => ({ value: c, label: `cli: ${c}` })),
  ];

  function stepCard(step: StepState, stage: StageState): HTMLElement {
    const card = h("div", { class: "pe-card" });

    const remove = h(
      "button",
      { class: "btn", type: "button", title: "Remove step", "aria-label": "Remove step" },
      "✕",
    );
    remove.addEventListener("click", () => {
      stage.tasks = stage.tasks.filter((t) => t !== step);
      if (stage.tasks.length === 0) state.stages = state.stages.filter((s) => s !== stage);
      renderRail();
      revalidate();
    });
    const kindSelect = select(
      "step kind",
      step.kind,
      [
        { value: "prompt", label: "prompt step" },
        { value: "pipeline", label: "pipeline step" },
      ],
      (value) => {
        step.kind = value === "pipeline" ? "pipeline" : "prompt";
        renderRail();
        revalidate();
      },
    );
    card.append(
      h(
        "div",
        { class: "pe-row" },
        textInput(step.title, "step title", (v) => {
          step.title = v;
          revalidate();
        }),
        kindSelect,
        remove,
      ),
    );

    if (step.kind === "pipeline") {
      const target = targets.find((t) => t.handlerId === step.target) ?? targets[0];
      if (step.target.length === 0 && target !== undefined) step.target = target.handlerId;
      card.append(
        select(
          "pipeline to run",
          step.target,
          targets.map((t) => ({ value: t.handlerId, label: `runs: ${t.handlerId}` })),
          (value) => {
            step.target = value;
            step.params = {};
            renderRail();
            revalidate();
          },
        ),
      );
      for (const key of target?.paramKeys ?? []) {
        card.append(
          h(
            "div",
            { class: "pe-row" },
            h("label", {}, key),
            textInput(step.params[key] ?? "", `optional ${key}`, (v) => {
              if (v.length > 0) step.params[key] = v;
              else delete step.params[key];
              revalidate();
            }),
          ),
        );
      }
      if (target?.acceptsModel === true) {
        card.append(
          select("model", step.model, modelOptions, (v) => {
            step.model = v;
            revalidate();
          }),
        );
      }
    } else {
      // Skills chips (toggle), command prefix, cli + model routing.
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
            revalidate();
          });
          chips.append(chip);
        }
        card.append(h("div", { class: "pe-row" }, h("label", {}, "skills"), chips));
      }
      card.append(
        h(
          "div",
          { class: "pe-row" },
          textInput(step.command, "command prefix (e.g. /spec) — optional", (v) => {
            step.command = v;
            revalidate();
          }),
        ),
        h(
          "div",
          { class: "pe-row" },
          select("cli", step.cli, cliOptions, (v) => {
            step.cli = v;
            revalidate();
          }),
          select("model", step.model, modelOptions, (v) => {
            step.model = v;
            revalidate();
          }),
        ),
      );
    }

    // Prompt editor with Write / Preview tabs (markdown).
    const textarea = document.createElement("textarea");
    textarea.value = step.prompt;
    textarea.placeholder =
      step.kind === "prompt"
        ? "The prompt (markdown). Reference earlier results with {{stages.1.<id>.result}}"
        : "The prompt delivered to the pipeline you picked";
    textarea.addEventListener("input", () => {
      step.prompt = textarea.value;
      revalidate();
    });
    const preview = h("div", { class: "pe-preview" });
    preview.style.display = "none";
    const writeTab = h("button", { class: "on", type: "button" }, "Write");
    const previewTab = h("button", { type: "button" }, "Preview");
    writeTab.addEventListener("click", () => {
      writeTab.classList.add("on");
      previewTab.classList.remove("on");
      preview.style.display = "none";
      textarea.style.display = "";
    });
    previewTab.addEventListener("click", () => {
      previewTab.classList.add("on");
      writeTab.classList.remove("on");
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
            renderRail();
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

    card.append(
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
    return card;
  }

  // ── the stage rail ────────────────────────────────────────────────────
  const rail = h("div", { class: "pe-rail" });
  function renderRail(): void {
    rail.replaceChildren();
    state.stages.forEach((stage, index) => {
      const cards = h("div", { class: "pe-cards" });
      for (const step of stage.tasks) cards.append(stepCard(step, stage));

      const addStep = h("button", { class: "btn", type: "button" }, "+ parallel step");
      addStep.addEventListener("click", () => {
        stage.tasks.push(freshStep(targets));
        renderRail();
        revalidate();
      });
      const removeStage = h("button", { class: "btn", type: "button" }, "remove stage");
      removeStage.addEventListener("click", () => {
        state.stages = state.stages.filter((s) => s !== stage);
        renderRail();
        revalidate();
      });
      rail.append(
        h(
          "div",
          { class: "pe-stage" },
          h(
            "div",
            { class: "pe-stage-head" },
            h("span", { class: "t" }, `Stage ${index + 1}`),
            h("span", { class: "hint" }, "steps in a stage run at the same time"),
            addStep,
            state.stages.length > 1 ? removeStage : null,
          ),
          cards,
        ),
      );
    });
    const addStage = h("button", { class: "btn", type: "button" }, "+ stage (runs after)");
    addStage.addEventListener("click", () => {
      state.stages.push({ tasks: [freshStep(targets)] });
      renderRail();
      revalidate();
    });
    rail.append(addStage);
  }

  // ── sidebar: how it runs + permissions ────────────────────────────────
  const orchestratorModelSelect = select(
    "orchestrator model",
    state.orchestratorModel,
    [{ value: "", label: "model: best available (benchmarks)" }, ...modelOptions.slice(1)],
    (v) => {
      state.orchestratorModel = v;
      revalidate();
    },
  );
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
        "Stages run in order; steps inside a stage run at the same time. Each stage sees the previous stage's results.",
      ),
      h(
        "label",
        { class: "pe-row" },
        orchestratorToggle,
        h(
          "span",
          { class: "pe-mini" },
          "Orchestrator: Vesper rewrites each stage's prompts from the results so far",
        ),
      ),
      orchestratorModelSelect,
      instructions,
      h(
        "label",
        { class: "pe-row", style: "margin-top:8px" },
        memoryToggle,
        h("span", { class: "pe-mini" }, "Ground the first stage in your semantic memory"),
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
      errorsHost,
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
          const step = state.stages.flatMap((s) => s.tasks).find((t) => t.id === suggestion.id);
          if (step === undefined) continue;
          const apply = h("button", { class: "btn", type: "button" }, `Apply to "${step.title}"`);
          apply.addEventListener("click", () => {
            if (suggestion.prompt !== undefined) step.prompt = suggestion.prompt;
            if (suggestion.cli !== undefined) step.cli = suggestion.cli;
            if (suggestion.model !== undefined) step.model = suggestion.model;
            renderRail();
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
            orchestratorModelSelect.value = state.orchestratorModel;
            revalidate();
          });
          panel.append(applyOrch);
        }
        improveHost.replaceChildren(panel);
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

  host.append(
    h("div", { class: "pe-top" }, back, nameInput, idLabel),
    h("div", { class: "pe-top" }, descriptionInput),
    h("div", { class: "pe-layout" }, rail, side),
    h(
      "div",
      { class: "pe-footer" },
      save,
      improve,
      state.isNew ? null : del,
      crossShare,
      h("span", { class: "pe-coming" }, "coming soon"),
    ),
    improveHost,
  );
  renderRail();
  revalidate();
  dirty = false;
}
