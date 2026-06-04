/// <reference lib="dom" />

import type { StatusResponse } from "./contracts.ts";
import { DOT, ICONS } from "./icons.ts";
import type { ApiClient, SectionModule } from "./section.ts";

interface TitlebarDeps {
  readonly api: ApiClient;
  readonly sections: readonly SectionModule[];
  readonly onNavigate: (id: string) => void;
}

/** Vesper wordmark glyph (four-point sparkle — matches the brand accent). */
const MARK =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2l1.8 6.4L20 12l-6.2 1.8L12 22l-1.8-8.2L4 12l6.2-3.6L12 2z" fill="currentColor"/></svg>';

/**
 * Mount the custom titlebar: brand mark + wordmark, a command search (focus with
 * Cmd/Ctrl-E; type to filter sections, Enter/click to jump), and live status pills
 * polled from `GET /api/status`. The bar is the window drag region (set in CSS);
 * its interactive children opt out via `.no-drag`.
 */
export function mountTitlebar(bar: HTMLElement, deps: TitlebarDeps): void {
  bar.replaceChildren();

  // Brand (left, after the macOS traffic-light inset reserved in CSS).
  const brand = document.createElement("div");
  brand.className = "tb-brand";
  brand.innerHTML = `<span class="tb-mark">${MARK}</span><span class="tb-word">Vesper</span>`;

  // Command search (center).
  const searchWrap = document.createElement("div");
  searchWrap.className = "tb-search no-drag";
  const input = document.createElement("input");
  input.type = "text";
  input.placeholder = "Search   Cmd+E";
  input.setAttribute("aria-label", "Search sections");
  const menu = document.createElement("div");
  menu.className = "tb-results";
  menu.hidden = true;
  searchWrap.innerHTML = `<span class="tb-search-ic">${ICONS.search}</span>`;
  searchWrap.append(input, menu);

  const renderResults = (): void => {
    const q = input.value.trim().toLowerCase();
    const matches = deps.sections.filter((s) => s.title.toLowerCase().includes(q));
    menu.replaceChildren();
    if (q.length === 0 || matches.length === 0) {
      menu.hidden = true;
      return;
    }
    for (const s of matches.slice(0, 8)) {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "tb-result";
      item.innerHTML = `<span class="glyph">${s.glyph}</span><span>${s.title}</span>`;
      item.addEventListener("click", () => {
        deps.onNavigate(s.id);
        input.value = "";
        menu.hidden = true;
        input.blur();
      });
      menu.append(item);
    }
    menu.hidden = false;
  };

  input.addEventListener("input", renderResults);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      input.value = "";
      menu.hidden = true;
      input.blur();
    } else if (e.key === "Enter") {
      const q = input.value.trim().toLowerCase();
      const top = deps.sections.find((s) => s.title.toLowerCase().includes(q));
      if (top !== undefined) {
        deps.onNavigate(top.id);
        input.value = "";
        menu.hidden = true;
        input.blur();
      }
    }
  });
  input.addEventListener("blur", () => {
    // Let a result click register before hiding.
    setTimeout(() => {
      menu.hidden = true;
    }, 150);
  });
  window.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "e") {
      e.preventDefault();
      input.focus();
      input.select();
    }
  });

  // Status pills (right).
  const pills = document.createElement("div");
  pills.className = "tb-pills no-drag";
  const daemonPill = pill("daemon", "connecting…");
  const cliPill = pill("cli", "…");
  pills.append(daemonPill.el, cliPill.el);

  bar.append(brand, searchWrap, pills);

  const refresh = async (): Promise<void> => {
    try {
      const s = await deps.api.getJson<StatusResponse>("/api/status");
      daemonPill.set(true, `v${s.version}`);
      const cli = s.defaultCli ?? "no CLI";
      const cliOk = s.clis.find((c) => c.name === s.defaultCli)?.ok ?? false;
      cliPill.set(s.defaultCli !== null && cliOk, cli);
    } catch {
      daemonPill.set(false, "offline");
      cliPill.set(false, "—");
    }
  };
  void refresh();
  const timer = window.setInterval(() => void refresh(), 5000);
  window.addEventListener("beforeunload", () => window.clearInterval(timer));
}

/** Build one status pill (a colored dot + a label). */
function pill(
  kind: string,
  initial: string,
): {
  el: HTMLElement;
  set: (ok: boolean, label: string) => void;
} {
  const el = document.createElement("span");
  el.className = "tb-pill";
  el.dataset.kind = kind;
  const dot = document.createElement("span");
  dot.className = "tb-dot";
  dot.innerHTML = DOT;
  const label = document.createElement("span");
  label.textContent = initial;
  el.append(dot, label);
  return {
    el,
    set(ok, text): void {
      el.dataset.ok = ok ? "true" : "false";
      label.textContent = text;
    },
  };
}
