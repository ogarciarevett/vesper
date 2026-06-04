/// <reference lib="dom" />
import type { PipelineConfig } from "../chat-types.ts";
import { ICONS } from "../shell/icons.ts";
import { h, type SectionContext, type SectionModule, sectionHeader } from "../shell/section.ts";

/** A small "on"/"off" enabled chip. */
function enabledBadge(enabled: boolean): HTMLElement {
  return h("span", { class: `badge ${enabled ? "ok" : ""}` }, enabled ? "on" : "off");
}

/**
 * Schedule — the cron/trigger expression for every configured pipeline. Reads
 * `GET /api/pipelines`; each task shows its enabled chip + schedule expression.
 */
export const scheduleSection: SectionModule = {
  id: "schedule",
  title: "Schedule",
  group: "vesper",
  glyph: ICONS.schedule,
  async mount(host: HTMLElement, ctx: SectionContext) {
    host.append(sectionHeader("Schedule", "When each pipeline runs — cron, event, or manual."));
    const panel = h("div", { class: "panel" }, h("div", { class: "panel-title" }, "Pipelines"));
    host.append(panel);

    try {
      const pipelines = await ctx.api.getJson<PipelineConfig[]>("/api/pipelines");
      if (pipelines.length === 0) {
        panel.append(h("p", { class: "empty-note" }, "No pipelines configured."));
        return;
      }
      for (const p of pipelines) {
        const left = h("span", { class: "k" }, p.id, enabledBadge(p.enabled));
        const right = h(
          "span",
          { class: "v mono" },
          p.scheduleExpr.trim() === "" ? "manual" : p.scheduleExpr,
        );
        panel.append(h("div", { class: "kv" }, left, right));
      }
    } catch (err) {
      panel.append(
        h("p", { class: "empty-note" }, err instanceof Error ? err.message : String(err)),
      );
    }
  },
};
