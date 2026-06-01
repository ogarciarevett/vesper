/// <reference lib="dom" />
import { resolveMark } from "./brand/index.ts";
import type { PipelineConfig, PipelineTemplate } from "./chat-types.ts";

/** Dependencies the templates screen borrows from {@link import("./main.ts")}. */
export interface TemplatesDeps {
  /** Surface a transient message via the shared toast. */
  readonly toast: (message: string) => void;
}

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (node === null) throw new Error(`missing #${id}`);
  return node as T;
}

/** Draw a pipeline's real brand mark into a small inline canvas (mirrors main.ts). */
function markCanvas(id: string, px: number): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = px;
  c.height = px;
  const mctx = c.getContext("2d");
  if (mctx !== null) resolveMark(id).draw(mctx, px / 2, px / 2, px * 0.38);
  return c;
}

/** A nullable cap value rendered as a readable string ("unlimited" for null). */
function capLabel(value: number | null): string {
  return value === null ? "unlimited" : String(value);
}

/**
 * The Helpers screen (editable pipeline templates, spec #4). Lists every registered
 * pipeline; expanding one reveals its editable prompt + default params (persisted via
 * `PUT /api/pipelines/:id/template`, gated by the out-of-band approval code) plus a
 * READ-ONLY view of its schedule, caps, and capabilities. Capability editing stays out
 * of this UI (code-defined); the schedule/caps view is informational until the backend
 * exposes a write path for them.
 */
export class TemplatesScreen {
  readonly #deps: TemplatesDeps;
  readonly #list = el<HTMLElement>("tpl-list");
  #loaded = false;

  constructor(deps: TemplatesDeps) {
    this.#deps = deps;
  }

  /** Load the pipeline list on first reveal; a no-op on subsequent opens. */
  async ensureLoaded(): Promise<void> {
    if (this.#loaded) return;
    this.#loaded = true;
    await this.reload();
  }

  /** (Re)fetch the pipeline list and render each as a collapsible editor. */
  async reload(): Promise<void> {
    try {
      const res = await fetch("/api/pipelines");
      if (!res.ok) {
        this.#deps.toast("could not load helpers");
        return;
      }
      const pipelines = (await res.json()) as PipelineConfig[];
      this.#list.replaceChildren();
      for (const p of pipelines) this.#list.append(this.#buildItem(p));
    } catch {
      this.#deps.toast("could not load helpers");
    }
  }

  /** Build one collapsible pipeline row (header toggles the editor body). */
  #buildItem(p: PipelineConfig): HTMLElement {
    const item = document.createElement("div");
    item.className = "tpl-item";
    item.dataset.id = p.id;

    const head = document.createElement("div");
    head.className = "tpl-head";
    head.setAttribute("role", "button");
    head.setAttribute("tabindex", "0");
    head.setAttribute("aria-expanded", "false");
    const mark = markCanvas(p.id, 30);
    mark.className = "tpl-mark";
    const id = document.createElement("span");
    id.className = "tpl-id";
    id.textContent = p.id;
    const kind = document.createElement("span");
    kind.className = "tpl-kind";
    kind.textContent = `${p.kind}${p.enabled ? "" : " · disabled"}`;
    const toggle = document.createElement("span");
    toggle.className = "tpl-toggle";
    toggle.textContent = "+";
    toggle.setAttribute("aria-hidden", "true");
    head.append(mark, id, kind, toggle);

    const body = document.createElement("div");
    body.className = "tpl-body";

    let built = false;
    const expand = (): void => {
      const open = item.classList.toggle("open");
      head.setAttribute("aria-expanded", String(open));
      toggle.textContent = open ? "−" : "+";
      if (open && !built) {
        built = true;
        void this.#buildEditor(p, body);
      }
    };
    head.addEventListener("click", expand);
    head.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        expand();
      }
    });

    item.append(head, body);
    return item;
  }

  /** Fetch the template + render the prompt/params editor and read-only config view. */
  async #buildEditor(p: PipelineConfig, body: HTMLElement): Promise<void> {
    let tpl: PipelineTemplate;
    try {
      const res = await fetch(`/api/pipelines/${encodeURIComponent(p.id)}/template`);
      if (!res.ok) {
        body.append(this.#note("could not load this helper's template", "err"));
        return;
      }
      tpl = (await res.json()) as PipelineTemplate;
    } catch {
      body.append(this.#note("could not load this helper's template", "err"));
      return;
    }

    const promptField = this.#textField("Instructions (prompt)", tpl.prompt, 4);
    const paramsField = this.#textField(
      "Default settings (JSON)",
      JSON.stringify(tpl.defaultParams, null, 2),
      5,
    );

    // Read-only config view (schedule, caps, capabilities) — informational.
    const cfg = document.createElement("div");
    cfg.className = "tpl-caps";
    const sched = document.createElement("div");
    sched.append(
      this.#kv("Schedule", tpl.config.scheduleExpr || "manual only"),
      this.#kv("Enabled", tpl.config.enabled ? "yes" : "no"),
      this.#kv("Runs/day", capLabel(tpl.config.maxRunsPerDay)),
      this.#kv("Max concurrent", capLabel(tpl.config.maxConcurrent)),
      this.#kv("Max duration (ms)", capLabel(tpl.config.maxDurationMs)),
    );
    cfg.append(sched);
    const caps = document.createElement("div");
    caps.style.marginTop = "8px";
    caps.append(document.createTextNode("Capabilities (code-defined): "));
    for (const c of tpl.config.requiredCapabilities) {
      const code = document.createElement("code");
      code.textContent = c;
      caps.append(code, document.createTextNode(" "));
    }
    if (tpl.config.requiredCapabilities.length === 0) {
      caps.append(document.createTextNode("none"));
    }
    cfg.append(caps);

    // Approval code + Save row. The PUT is privileged: it needs a single-use code
    // minted out-of-band by the daemon (it is never served to the page).
    const codeWrap = document.createElement("div");
    codeWrap.className = "tpl-field";
    const codeLabel = document.createElement("label");
    const codeId = `tpl-code-${p.id}`;
    codeLabel.setAttribute("for", codeId);
    codeLabel.textContent = "Approval code (from the Vesper daemon)";
    const codeInput = document.createElement("input");
    codeInput.type = "text";
    codeInput.id = codeId;
    codeInput.autocomplete = "off";
    codeInput.placeholder = "paste the one-time code";
    codeWrap.append(codeLabel, codeInput);

    const saveRow = document.createElement("div");
    saveRow.className = "tpl-save-row";
    const save = document.createElement("button");
    save.type = "button";
    save.className = "tpl-save";
    save.textContent = "Save instructions";
    const note = this.#note("", "");
    saveRow.append(save, note);

    save.addEventListener("click", () => {
      void this.#save(p.id, {
        prompt: promptField.textarea.value,
        paramsRaw: paramsField.textarea.value,
        code: codeInput.value.trim(),
        save,
        note,
        codeInput,
      });
    });

    body.append(
      promptField.field,
      paramsField.field,
      cfg,
      codeWrap,
      saveRow,
      this.#note(
        "Schedule, limits, and capabilities are shown for reference; editing them is not yet available here.",
        "",
      ),
    );
  }

  /** Validate + PUT the prompt/params; surface the result inline. */
  async #save(
    pipelineId: string,
    args: {
      prompt: string;
      paramsRaw: string;
      code: string;
      save: HTMLButtonElement;
      note: HTMLElement;
      codeInput: HTMLInputElement;
    },
  ): Promise<void> {
    const { prompt, paramsRaw, code, save, note, codeInput } = args;
    if (code.length === 0) {
      this.#setNote(note, "an approval code is required to save", "err");
      codeInput.focus();
      return;
    }
    let defaultParams: Record<string, unknown>;
    try {
      const parsed: unknown = paramsRaw.trim().length === 0 ? {} : JSON.parse(paramsRaw);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new Error("not an object");
      }
      defaultParams = parsed as Record<string, unknown>;
    } catch {
      this.#setNote(note, "default settings must be a JSON object", "err");
      return;
    }

    save.disabled = true;
    this.#setNote(note, "saving…", "");
    try {
      const res = await fetch(`/api/pipelines/${encodeURIComponent(pipelineId)}/template`, {
        method: "PUT",
        headers: { "content-type": "application/json", "x-vesper-approval": code },
        body: JSON.stringify({ prompt, defaultParams }),
      });
      if (res.ok) {
        this.#setNote(note, "saved", "ok");
        codeInput.value = ""; // the code is single-use; force a fresh one next time.
        this.#deps.toast(`${pipelineId} updated`);
      } else {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        this.#setNote(note, body.error ?? "save failed", "err");
      }
    } catch {
      this.#setNote(note, "save failed", "err");
    } finally {
      save.disabled = false;
    }
  }

  /** A labelled textarea field; returns the wrapper + the textarea for reading. */
  #textField(
    label: string,
    value: string,
    rows: number,
  ): { field: HTMLElement; textarea: HTMLTextAreaElement } {
    const field = document.createElement("div");
    field.className = "tpl-field";
    const lbl = document.createElement("label");
    const taId = `tpl-${label.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}-${Math.random().toString(36).slice(2, 7)}`;
    lbl.setAttribute("for", taId);
    lbl.textContent = label;
    const textarea = document.createElement("textarea");
    textarea.id = taId;
    textarea.rows = rows;
    textarea.value = value;
    field.append(lbl, textarea);
    return { field, textarea };
  }

  /** A small key/value line for the read-only config view. */
  #kv(key: string, value: string): HTMLElement {
    const line = document.createElement("div");
    const k = document.createElement("strong");
    k.textContent = `${key}: `;
    line.append(k, document.createTextNode(value));
    return line;
  }

  #note(text: string, kind: "" | "ok" | "err"): HTMLElement {
    const note = document.createElement("p");
    note.className = `tpl-note${kind ? ` ${kind}` : ""}`;
    note.textContent = text;
    note.setAttribute("role", "status");
    return note;
  }

  #setNote(note: HTMLElement, text: string, kind: "" | "ok" | "err"): void {
    note.className = `tpl-note${kind ? ` ${kind}` : ""}`;
    note.textContent = text;
  }
}
