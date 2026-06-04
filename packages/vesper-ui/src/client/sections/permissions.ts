/// <reference lib="dom" />
import type { PipelineConfig } from "../chat-types.ts";
import { ICONS } from "../shell/icons.ts";
import { h, type SectionContext, type SectionModule, sectionHeader } from "../shell/section.ts";

/** Render a pipeline's required capabilities as a row of chips (or "none"). */
function caps(values: readonly string[]): HTMLElement {
  const wrap = h("span", { class: "v" });
  if (values.length === 0) {
    wrap.append(h("span", { class: "muted" }, "none"));
    return wrap;
  }
  for (const c of values) wrap.append(h("span", { class: "badge", style: "margin-left:6px" }, c));
  return wrap;
}

/**
 * Permissions — the code-defined, deny-by-default capabilities each pipeline requests.
 * Reads `GET /api/pipelines`; read-only (capabilities are declared in code, not the UI).
 */
export const permissionsSection: SectionModule = {
  id: "permissions",
  title: "Permissions",
  group: "computer",
  glyph: ICONS.permissions,
  async mount(host: HTMLElement, ctx: SectionContext) {
    host.append(
      sectionHeader("Permissions", "What each pipeline is allowed to touch on this machine."),
    );
    const panel = h(
      "div",
      { class: "panel" },
      h(
        "p",
        { class: "muted" },
        "Capabilities are declared in each pipeline's code and are deny-by-default — a pipeline can only do what it explicitly requests.",
      ),
    );
    host.append(panel);

    try {
      const pipelines = await ctx.api.getJson<PipelineConfig[]>("/api/pipelines");
      if (pipelines.length === 0) {
        panel.append(h("p", { class: "empty-note" }, "No pipelines configured."));
        return;
      }
      const grid = h(
        "div",
        { class: "panel" },
        h("div", { class: "panel-title" }, "Requested capabilities"),
      );
      for (const p of pipelines) {
        grid.append(
          h("div", { class: "kv" }, h("span", { class: "k" }, p.id), caps(p.requiredCapabilities)),
        );
      }
      host.append(grid);
    } catch (err) {
      panel.append(
        h("p", { class: "empty-note" }, err instanceof Error ? err.message : String(err)),
      );
    }
  },
};
