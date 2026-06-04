/// <reference lib="dom" />
import type { StatusResponse } from "../shell/contracts.ts";
import { ICONS } from "../shell/icons.ts";
import { h, type SectionContext, type SectionModule, sectionHeader } from "../shell/section.ts";

/** About — what Vesper is, plus the running version. */
export const aboutSection: SectionModule = {
  id: "about",
  title: "About",
  group: "computer",
  glyph: ICONS.about,
  async mount(host: HTMLElement, ctx: SectionContext) {
    host.append(sectionHeader("About Vesper"));
    let version = "0.1.0";
    try {
      version = (await ctx.api.getJson<StatusResponse>("/api/status")).version;
    } catch {
      // keep the default.
    }
    host.append(
      h(
        "div",
        { class: "panel" },
        h("div", { class: "panel-title" }, "Vesper"),
        h(
          "p",
          { class: "muted", style: "line-height:1.65;margin:0 0 12px" },
          "A local-first runtime for personal automation agents. Vesper orchestrates the AI CLI you already use — nothing leaves this machine except the calls your own CLI makes.",
        ),
        h(
          "div",
          { class: "kv" },
          h("span", { class: "k" }, "Version"),
          h("span", { class: "v mono" }, `v${version}`),
        ),
        h(
          "div",
          { class: "kv" },
          h("span", { class: "k" }, "Runs on"),
          h("span", { class: "v" }, "Bun · your helper CLI"),
        ),
      ),
    );
  },
};
