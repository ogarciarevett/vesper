/// <reference lib="dom" />
import type { PipelineConfig, PipelineTemplate } from "../chat-types.ts";
import { ICONS } from "../shell/icons.ts";
import {
  h,
  injectStyle,
  type SectionContext,
  type SectionModule,
  sectionHeader,
} from "../shell/section.ts";

const STYLE_ID = "sec-pipelines-style";
const STYLE = `
.pl-prompt { font-family: var(--mono); font-size: 12.5px; white-space: pre-wrap; word-break: break-word;
  background: var(--surface-2); border: 1px solid var(--border); border-radius: 8px; padding: 12px;
  max-height: 220px; overflow: auto; margin: 12px 0 8px; }
.pl-caps { display: flex; flex-wrap: wrap; gap: 6px; }
`;

/** A small chip for the pipeline kind/enabled state. */
function chip(label: string, ok = false): HTMLElement {
  return h("span", { class: `badge ${ok ? "ok" : ""}` }, label);
}

/** Build the read-only template block (prompt + required capabilities). */
function templateBlock(t: PipelineTemplate): HTMLElement {
  const caps = h("div", { class: "pl-caps" });
  if (t.config.requiredCapabilities.length === 0)
    caps.append(h("span", { class: "muted" }, "no capabilities"));
  for (const cap of t.config.requiredCapabilities) caps.append(h("span", { class: "badge" }, cap));
  return h("div", {}, h("pre", { class: "pl-prompt" }, t.prompt), caps);
}

/**
 * Pipelines — every configured pipeline as a card with a lazily-loaded, read-only
 * template view (prompt + required capabilities). Editing is out of scope (slice 1).
 */
export const pipelinesSection: SectionModule = {
  id: "pipelines",
  title: "Pipelines",
  group: "vesper",
  glyph: ICONS.pipelines,
  async mount(host: HTMLElement, ctx: SectionContext) {
    injectStyle(STYLE_ID, STYLE);
    host.append(sectionHeader("Pipelines", "The personal automations Vesper runs for you."));
    const list = h("div", {});
    host.append(list);

    try {
      const pipelines = await ctx.api.getJson<PipelineConfig[]>("/api/pipelines");
      if (pipelines.length === 0) {
        list.append(
          h("div", { class: "panel" }, h("p", { class: "empty-note" }, "No pipelines configured.")),
        );
        return;
      }
      for (const p of pipelines) {
        const slot = h("div", {});
        let template: PipelineTemplate | null = null;
        const btn = h("button", { class: "btn", type: "button" }, "View template");
        btn.addEventListener("click", () => {
          void (async (): Promise<void> => {
            if (slot.firstChild !== null) {
              slot.replaceChildren();
              btn.textContent = "View template";
              return;
            }
            try {
              template ??= await ctx.api.getJson<PipelineTemplate>(
                `/api/pipelines/${p.id}/template`,
              );
              slot.replaceChildren(templateBlock(template));
              btn.textContent = "Hide template";
            } catch (err) {
              slot.replaceChildren(
                h("p", { class: "empty-note" }, err instanceof Error ? err.message : String(err)),
              );
            }
          })();
        });
        list.append(
          h(
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
            btn,
            slot,
          ),
        );
      }
    } catch (err) {
      list.append(
        h(
          "div",
          { class: "panel" },
          h("p", { class: "empty-note" }, err instanceof Error ? err.message : String(err)),
        ),
      );
    }
  },
};
