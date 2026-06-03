/// <reference lib="dom" />
import { h, type SectionGroup, type SectionModule, sectionHeader } from "../shell/section.ts";

/**
 * Build an honest "coming soon" section — a nav entry + a card that names the owning
 * spec, never faked functionality (Acceptance #5). Used for Skills-train, Memory, and
 * Voice in slice 1.
 */
export function stubSection(opts: {
  id: string;
  title: string;
  group: SectionGroup;
  glyph: string;
  blurb: string;
  spec: string;
}): SectionModule {
  return {
    id: opts.id,
    title: opts.title,
    group: opts.group,
    glyph: opts.glyph,
    mount(host) {
      host.append(
        sectionHeader(opts.title),
        h(
          "div",
          { class: "panel" },
          h(
            "div",
            { class: "coming-soon" },
            h("span", { class: "cs-tag" }, "Coming soon"),
            h("p", { class: "muted" }, opts.blurb),
            h("p", { class: "muted" }, `Tracked in ${opts.spec}.`),
          ),
        ),
      );
    },
  };
}
