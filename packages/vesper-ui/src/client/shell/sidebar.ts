/// <reference lib="dom" />
import { h, type SectionGroup, type SectionModule } from "./section.ts";

/** Per-section glyph accent (a named hue mapped to a color in the shell CSS). */
const ACCENT: Record<string, string> = {
  chat: "violet",
  pipelines: "blue",
  channels: "pink",
  schedule: "amber",
  skills: "teal",
  memory: "blue",
  runtime: "green",
  cli: "teal",
  permissions: "violet",
  sandbox: "amber",
  voice: "pink",
  settings: "slate",
  diagnostics: "green",
  about: "slate",
};

const GROUP_LABEL: Record<SectionGroup, string | null> = {
  primary: null,
  vesper: "Vesper",
  computer: "This Computer",
};

const GROUP_ORDER: readonly SectionGroup[] = ["primary", "vesper", "computer"];

/**
 * Render the grouped sidebar nav from the registered sections. Returns a
 * `setActive(id)` the router's onChange calls to move the highlight + `aria-current`.
 */
export function renderSidebar(
  nav: HTMLElement,
  sections: readonly SectionModule[],
  onNavigate: (id: string) => void,
): { setActive: (id: string) => void } {
  nav.replaceChildren();
  const buttons = new Map<string, HTMLButtonElement>();

  for (const group of GROUP_ORDER) {
    const inGroup = sections.filter((s) => s.group === group);
    if (inGroup.length === 0) continue;
    const label = GROUP_LABEL[group];
    if (label !== null) nav.append(h("div", { class: "nav-group" }, label));
    for (const section of inGroup) {
      const btn = h(
        "button",
        {
          type: "button",
          class: "navi",
          "data-accent": ACCENT[section.id] ?? "slate",
          "aria-current": "false",
          onclick: () => onNavigate(section.id),
        },
        h("span", { class: "glyph", html: section.glyph }),
        h("span", { class: "navi-label" }, section.title),
      );
      buttons.set(section.id, btn);
      nav.append(btn);
    }
  }

  return {
    setActive(id: string): void {
      for (const [bid, btn] of buttons) {
        btn.setAttribute("aria-current", bid === id ? "true" : "false");
      }
    },
  };
}
