/// <reference lib="dom" />
import type { StatusResponse } from "../shell/contracts.ts";
import { ICONS } from "../shell/icons.ts";
import { h, type SectionContext, type SectionModule, sectionHeader } from "../shell/section.ts";
import { setTheme, THEMES } from "../shell/themes.ts";

/**
 * Settings — pick the app theme (re-skins instantly, persisted per browser) and view
 * the read-only runtime config (default helper-CLI, UI port, version). Writing config
 * back to `~/.vesper/config.json` is a follow-up (the privileged approval-gated PUT);
 * theme is client-side state so it needs no server write.
 */
export const settingsSection: SectionModule = {
  id: "settings",
  title: "Settings",
  group: "computer",
  glyph: ICONS.settings,
  async mount(host: HTMLElement, ctx: SectionContext) {
    host.append(sectionHeader("Settings", "Appearance and runtime configuration."));

    // Appearance — theme picker.
    const active = document.body.dataset.theme ?? "dark";
    const swatches = h("div", { class: "theme-row" });
    const paint = (): void => {
      const cur = document.body.dataset.theme ?? "dark";
      for (const node of Array.from(swatches.children)) {
        (node as HTMLElement).setAttribute(
          "aria-current",
          (node as HTMLElement).dataset.theme === cur ? "true" : "false",
        );
      }
    };
    for (const t of THEMES) {
      const btn = h(
        "button",
        {
          type: "button",
          class: "theme-swatch",
          "data-theme": t.id,
          "aria-current": t.id === active ? "true" : "false",
          onclick: () => {
            setTheme(t.id);
            paint();
            ctx.toast(`Theme: ${t.displayName}`);
          },
        },
        h("span", { class: `sw-chip sw-${t.id}` }),
        h("span", null, t.displayName),
      );
      swatches.append(btn);
    }

    host.append(
      h("div", { class: "panel" }, h("div", { class: "panel-title" }, "Appearance"), swatches),
    );

    const cfg = h("div", { class: "panel" }, h("div", { class: "panel-title" }, "Runtime"));
    host.append(cfg);
    try {
      const s = await ctx.api.getJson<StatusResponse>("/api/status");
      cfg.append(
        kv("Default helper CLI", s.defaultCli ?? "none selected"),
        kv("Installed CLIs", s.clis.length > 0 ? s.clis.map((c) => c.name).join(", ") : "none"),
        kv("UI port", String(s.uiPort), true),
        kv("Daemon version", `v${s.version}`, true),
      );
    } catch {
      cfg.append(
        h("p", { class: "muted" }, "Runtime config is unavailable (daemon not reachable)."),
      );
    }

    injectThemeStyle();
  },
};

function kv(k: string, v: string, mono = false): HTMLElement {
  return h(
    "div",
    { class: "kv" },
    h("span", { class: "k" }, k),
    h("span", { class: mono ? "v mono" : "v" }, v),
  );
}

function injectThemeStyle(): void {
  if (document.getElementById("settings-css") !== null) return;
  const style = document.createElement("style");
  style.id = "settings-css";
  style.textContent = `
    .theme-row { display: flex; gap: 12px; flex-wrap: wrap; }
    .theme-swatch { display: flex; align-items: center; gap: 10px; padding: 10px 14px; border-radius: 12px; border: 1px solid var(--border); background: var(--surface-2); color: var(--ink); font: inherit; font-size: 14px; font-weight: 600; cursor: pointer; }
    .theme-swatch:hover { background: var(--surface-strong); }
    .theme-swatch[aria-current="true"] { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent); }
    .sw-chip { width: 26px; height: 26px; border-radius: 7px; border: 1px solid var(--border-strong); }
    .sw-dark { background: linear-gradient(135deg, #1a1a26, #0c0b12); }
    .sw-glass { background: linear-gradient(135deg, #eef2fe, #fdeef5); }
    .sw-hearth { background: linear-gradient(135deg, #3a2a20, #ffb454); }
  `;
  document.head.append(style);
}
