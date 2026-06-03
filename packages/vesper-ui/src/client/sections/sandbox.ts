/// <reference lib="dom" />
import type { PipelineConfig } from "../chat-types.ts";
import { ICONS } from "../shell/icons.ts";
import { h, type SectionContext, type SectionModule, sectionHeader } from "../shell/section.ts";

/** Summarize a pipeline's filesystem/network reach as compact badges. */
function reach(values: readonly string[]): HTMLElement {
  const wrap = h("span", { class: "v" });
  const files = values.some((c) => c.startsWith("FS_"));
  const network = values.includes("NETWORK_FETCH");
  if (files) wrap.append(h("span", { class: "badge warn", style: "margin-left:6px" }, "files"));
  if (network) wrap.append(h("span", { class: "badge warn", style: "margin-left:6px" }, "network"));
  if (!files && !network) wrap.append(h("span", { class: "muted" }, "contained"));
  return wrap;
}

/**
 * Sandbox — how Vesper contains each pipeline. Filesystem and network access are
 * denied by default and granted per task; this surface is read-only in slice 1.
 */
export const sandboxSection: SectionModule = {
  id: "sandbox",
  title: "Sandbox",
  group: "computer",
  glyph: ICONS.sandbox,
  async mount(host: HTMLElement, ctx: SectionContext) {
    host.append(sectionHeader("Sandbox", "How Vesper contains what each pipeline can reach."));
    host.append(
      h(
        "div",
        { class: "panel" },
        h("div", { class: "panel-title" }, "Containment"),
        h(
          "p",
          { class: "muted" },
          "Each pipeline runs with only the capabilities it declares — filesystem and network access are denied by default and granted per task.",
        ),
      ),
    );

    const panel = h(
      "div",
      { class: "panel" },
      h("div", { class: "panel-title" }, "Per-pipeline reach"),
    );
    host.append(panel);

    try {
      const pipelines = await ctx.api.getJson<PipelineConfig[]>("/api/pipelines");
      if (pipelines.length === 0) {
        panel.append(h("p", { class: "empty-note" }, "No pipelines configured."));
        return;
      }
      for (const p of pipelines) {
        panel.append(
          h("div", { class: "kv" }, h("span", { class: "k" }, p.id), reach(p.requiredCapabilities)),
        );
      }
    } catch (err) {
      panel.append(
        h("p", { class: "empty-note" }, err instanceof Error ? err.message : String(err)),
      );
    }
  },
};
