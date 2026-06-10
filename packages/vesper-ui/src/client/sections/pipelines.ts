/// <reference lib="dom" />
/**
 * Pipelines — the primary pipeline surface (specs/pipeline-editor.md): your saved
 * pipelines (Run / Edit / New, full editor) above the built-ins (Run + read-only
 * template). Everything drives the same daemon routes as `vesper pipeline`.
 */

import type { PipelineConfig, PipelineTemplate } from "../chat-types.ts";
import { ICONS } from "../shell/icons.ts";
import {
  h,
  injectStyle,
  type SectionContext,
  type SectionModule,
  sectionHeader,
} from "../shell/section.ts";
import { openPipelineEditor } from "./pipeline-editor.ts";

const STYLE_ID = "sec-pipelines-style";
const STYLE = `
.pl-prompt { font-family: var(--mono); font-size: 12.5px; white-space: pre-wrap; word-break: break-word;
  background: var(--surface-2); border: 1px solid var(--border); border-radius: 8px; padding: 12px;
  max-height: 220px; overflow: auto; margin: 12px 0 8px; }
.pl-caps { display: flex; flex-wrap: wrap; gap: 6px; }
.pl-actions { display: flex; gap: 8px; margin-top: 8px; flex-wrap: wrap; }
.pl-result { font-size: 12.5px; white-space: pre-wrap; word-break: break-word; border-left: 3px solid var(--accent);
  padding: 6px 10px; margin-top: 8px; max-height: 200px; overflow: auto; }
.pl-params { display: flex; flex-direction: column; gap: 6px; margin-top: 8px; }
.pl-params input { font: inherit; font-size: 12.5px; background: var(--surface-2); color: var(--ink);
  border: 1px solid var(--border); border-radius: 8px; padding: 6px 9px; }
`;

interface CustomRow {
  readonly id: string;
  readonly name: string;
  readonly revision: number;
  readonly capabilities: readonly string[];
}

function chip(label: string, ok = false): HTMLElement {
  return h("span", { class: `badge ${ok ? "ok" : ""}` }, label);
}

/** Run a task and render the outcome into `resultHost` (button disabled meanwhile). */
function runTask(
  ctx: SectionContext,
  taskId: string,
  params: Readonly<Record<string, string>>,
  button: HTMLButtonElement,
  resultHost: HTMLElement,
): void {
  button.disabled = true;
  button.textContent = "Running…";
  resultHost.replaceChildren(
    h("div", { class: "pl-result" }, "Working — watch the Chat activity rail for live steps."),
  );
  void ctx.api
    .postJson<{ status?: string; summary?: string; runId?: string | null; error?: string }>(
      `/api/pipelines/${encodeURIComponent(taskId)}/run`,
      Object.keys(params).length > 0 ? { params } : {},
    )
    .then((outcome) => {
      if (outcome.error !== undefined) throw new Error(outcome.error);
      resultHost.replaceChildren(
        h(
          "div",
          { class: "pl-result" },
          h("strong", {}, outcome.status ?? "done"),
          h("div", {}, outcome.summary ?? ""),
        ),
      );
    })
    .catch((err: unknown) => {
      resultHost.replaceChildren(
        h("div", { class: "pl-result" }, err instanceof Error ? err.message : String(err)),
      );
    })
    .finally(() => {
      button.disabled = false;
      button.textContent = "Run";
    });
}

/** Card for one saved (custom) pipeline. */
function customCard(ctx: SectionContext, row: CustomRow, onEdit: () => void): HTMLElement {
  const result = h("div", {});
  const run = h(
    "button",
    { class: "btn primary", type: "button", "aria-label": `Run ${row.name}` },
    "Run",
  ) as HTMLButtonElement;
  run.addEventListener("click", () => runTask(ctx, `custom:${row.id}`, {}, run, result));
  const edit = h(
    "button",
    { class: "btn", type: "button", "aria-label": `Edit ${row.name}` },
    "Edit",
  );
  edit.addEventListener("click", onEdit);

  const caps = h("div", { class: "pl-caps" });
  for (const cap of row.capabilities) caps.append(chip(cap));

  return h(
    "div",
    { class: "panel" },
    h("div", { class: "panel-title" }, row.name, " ", chip(`rev ${row.revision}`, true)),
    h("p", { class: "muted" }, `id: ${row.id}`),
    caps,
    h("div", { class: "pl-actions" }, run, edit),
    result,
  );
}

/** Card for one built-in pipeline: Run (params prefilled from the template) + template. */
function builtinCard(ctx: SectionContext, p: PipelineConfig): HTMLElement {
  const slot = h("div", {});
  const result = h("div", {});
  let template: PipelineTemplate | null = null;

  const run = h(
    "button",
    { class: "btn primary", type: "button", "aria-label": `Run ${p.id}` },
    "Run",
  ) as HTMLButtonElement;
  const paramsHost = h("div", {});
  run.addEventListener("click", () => {
    void (async (): Promise<void> => {
      template ??= await ctx.api
        .getJson<PipelineTemplate>(`/api/pipelines/${encodeURIComponent(p.id)}/template`)
        .catch(() => null);
      const defaults = template?.defaultParams ?? {};
      const keys = Object.keys(defaults);
      if (paramsHost.firstChild !== null) {
        paramsHost.replaceChildren();
        return;
      }
      // A tiny k=v form prefilled from the template; empty values are dropped.
      const inputs = new Map<string, HTMLInputElement>();
      const form = h("div", { class: "pl-params" });
      const rows = keys.length > 0 ? keys : ["message"];
      for (const key of rows) {
        const input = h("input", {
          type: "text",
          placeholder: key,
          value: typeof defaults[key] === "string" ? (defaults[key] as string) : "",
        }) as HTMLInputElement;
        inputs.set(key, input);
        form.append(h("label", { class: "muted" }, key), input);
      }
      const go = h("button", { class: "btn primary", type: "button" }, "Run") as HTMLButtonElement;
      go.addEventListener("click", () => {
        const params: Record<string, string> = {};
        for (const [key, input] of inputs) {
          if (input.value.trim().length > 0) params[key] = input.value.trim();
        }
        paramsHost.replaceChildren();
        runTask(ctx, p.id, params, run, result);
      });
      form.append(go);
      paramsHost.replaceChildren(form);
    })();
  });

  const viewBtn = h(
    "button",
    { class: "btn", type: "button", "aria-label": `View template for ${p.id}` },
    "View template",
  );
  viewBtn.addEventListener("click", () => {
    void (async (): Promise<void> => {
      if (slot.firstChild !== null) {
        slot.replaceChildren();
        viewBtn.textContent = "View template";
        return;
      }
      try {
        template ??= await ctx.api.getJson<PipelineTemplate>(
          `/api/pipelines/${encodeURIComponent(p.id)}/template`,
        );
        const caps = h("div", { class: "pl-caps" });
        if (template.config.requiredCapabilities.length === 0)
          caps.append(h("span", { class: "muted" }, "no capabilities"));
        for (const cap of template.config.requiredCapabilities)
          caps.append(h("span", { class: "badge" }, cap));
        slot.replaceChildren(h("div", {}, h("pre", { class: "pl-prompt" }, template.prompt), caps));
        viewBtn.textContent = "Hide template";
      } catch (err) {
        slot.replaceChildren(
          h("p", { class: "empty-note" }, err instanceof Error ? err.message : String(err)),
        );
      }
    })();
  });

  return h(
    "div",
    { class: "panel" },
    h(
      "div",
      { class: "panel-title" },
      p.id,
      " ",
      chip(p.kind),
      " ",
      chip(p.enabled ? "on" : "off", p.enabled),
    ),
    h("div", { class: "pl-actions" }, run, viewBtn),
    paramsHost,
    slot,
    result,
  );
}

/**
 * Pipelines — list view (yours + built-ins) with an internal editor view. The
 * editor mounts into the same host; closing it re-renders the list.
 */
export const pipelinesSection: SectionModule = {
  id: "pipelines",
  title: "Pipelines",
  group: "vesper",
  glyph: ICONS.pipelines,
  async mount(host: HTMLElement, ctx: SectionContext) {
    injectStyle(STYLE_ID, STYLE);

    const renderList = async (): Promise<void> => {
      host.replaceChildren();
      host.append(sectionHeader("Pipelines", "The personal automations Vesper runs for you."));

      const newBtn = h("button", { class: "btn primary", type: "button" }, "New pipeline");
      newBtn.addEventListener("click", () => {
        void openPipelineEditor(host, ctx, { id: null, onClose: () => void renderList() });
      });
      host.append(h("div", { class: "pl-actions", style: "margin-bottom: 14px" }, newBtn));

      const yours = h("div", {});
      const builtins = h("div", {});
      host.append(
        h("div", { class: "panel-title", style: "margin: 6px 0" }, "Yours"),
        yours,
        h("div", { class: "panel-title", style: "margin: 14px 0 6px" }, "Built-in"),
        builtins,
      );

      try {
        const custom = await ctx.api.getJson<CustomRow[]>("/api/pipelines/custom");
        if (custom.length === 0) {
          yours.append(
            h(
              "div",
              { class: "panel" },
              h(
                "p",
                { class: "empty-note" },
                "No saved pipelines yet — press New pipeline to build one out of prompts, skills, and the built-ins.",
              ),
            ),
          );
        }
        for (const row of custom) {
          yours.append(
            customCard(ctx, row, () => {
              void openPipelineEditor(host, ctx, {
                id: row.id,
                onClose: () => void renderList(),
              });
            }),
          );
        }
      } catch (err) {
        yours.append(
          h(
            "div",
            { class: "panel" },
            h("p", { class: "empty-note" }, err instanceof Error ? err.message : String(err)),
          ),
        );
      }

      try {
        const pipelines = await ctx.api.getJson<PipelineConfig[]>("/api/pipelines");
        for (const p of pipelines.filter((row) => !row.id.startsWith("custom:"))) {
          builtins.append(builtinCard(ctx, p));
        }
      } catch (err) {
        builtins.append(
          h(
            "div",
            { class: "panel" },
            h("p", { class: "empty-note" }, err instanceof Error ? err.message : String(err)),
          ),
        );
      }
    };

    await renderList();
  },
};
