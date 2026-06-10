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
.pl-prompt-entry summary { cursor: pointer; font-size: 12.5px; font-weight: 600; padding: 4px 0; }
.pl-prompt-entry .pl-prompt { margin: 4px 0 8px; }
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

/** What a built-in accepts when run (from the orchestration contract, when it has one). */
interface RunShape {
  readonly promptParam?: string;
  readonly paramKeys: readonly string[];
}

/** Card for one built-in pipeline: Run (params from contract + template) + template. */
function builtinCard(
  ctx: SectionContext,
  p: PipelineConfig,
  shape: RunShape | undefined,
): HTMLElement {
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
      if (paramsHost.firstChild !== null) {
        paramsHost.replaceChildren();
        return;
      }
      // The real inputs come from the pipeline's orchestration contract (its
      // prompt param first), merged with any template defaults. A pipeline that
      // declares none (e.g. benchmark-ingest) runs immediately — no empty form.
      const rows = [
        ...new Set([
          ...(shape?.promptParam !== undefined ? [shape.promptParam] : []),
          ...(shape?.paramKeys ?? []),
          ...(p.id === "router" ? ["message"] : []),
          ...Object.keys(defaults),
        ]),
      ];
      if (rows.length === 0) {
        runTask(ctx, p.id, {}, run, result);
        return;
      }
      // A tiny k=v form prefilled from the template; empty values are dropped.
      const inputs = new Map<string, HTMLInputElement>();
      const form = h("div", { class: "pl-params" });
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
        // Prefer the editable template row; otherwise show the built-in's REAL
        // prompt catalog (read-only, {{...}} = dynamic parts). Only a pipeline
        // with neither gets the honest empty note.
        const prompts = template.prompts ?? [];
        let promptBlock: HTMLElement;
        if (template.prompt.trim().length > 0) {
          promptBlock = h("pre", { class: "pl-prompt" }, template.prompt);
        } else if (prompts.length > 0) {
          promptBlock = h(
            "div",
            {},
            h(
              "p",
              { class: "muted" },
              "The real prompts this pipeline sends — read-only; {{...}} marks the parts filled in per run.",
            ),
            ...prompts.map((entry) =>
              h(
                "details",
                { class: "pl-prompt-entry" },
                h("summary", {}, entry.name),
                h("pre", { class: "pl-prompt" }, entry.template),
              ),
            ),
          );
        } else {
          promptBlock = h(
            "p",
            { class: "empty-note" },
            "This pipeline's behavior is built into Vesper itself — there is no editable prompt template (yet). Your own pipelines are fully editable.",
          );
        }
        slot.replaceChildren(h("div", {}, promptBlock, caps));
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
      const autonomousBtn = h(
        "button",
        {
          class: "btn",
          type: "button",
          title: "Vesper writes every prompt itself and stops when the goal is met",
        },
        "Start autonomous — you set the goal",
      );
      autonomousBtn.addEventListener("click", () => {
        void openPipelineEditor(host, ctx, {
          id: null,
          preset: "autonomous",
          onClose: () => void renderList(),
        });
      });
      host.append(
        h("div", { class: "pl-actions", style: "margin-bottom: 14px" }, newBtn, autonomousBtn),
      );

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
        const [pipelines, targets] = await Promise.all([
          ctx.api.getJson<PipelineConfig[]>("/api/pipelines"),
          ctx.api
            .getJson<Array<{ handlerId: string; promptParam: string; paramKeys: string[] }>>(
              "/api/pipelines/custom/targets",
            )
            .catch(() => []),
        ]);
        const shapes = new Map(
          targets.map((t) => [t.handlerId, { promptParam: t.promptParam, paramKeys: t.paramKeys }]),
        );
        for (const p of pipelines.filter((row) => !row.id.startsWith("custom:"))) {
          builtins.append(builtinCard(ctx, p, shapes.get(p.handlerId)));
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
