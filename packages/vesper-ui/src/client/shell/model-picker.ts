/// <reference lib="dom" />
/**
 * Model picker (Omar 2026-06-10): replaces the raw `<select>` of model ids with
 * a searchable, provider-grouped dropdown — each row shows the provider mark
 * (model-mark.ts), the model's display name, and a small meta line (tier or
 * context window). Groups: the Vesper catalog (the curated runnable set) first,
 * then the live directory per provider (`GET /api/models/directory`).
 *
 * Interaction pattern only is borrowed from the usual node-editor combos
 * (ComfyUI et al.); the code is original and dependency-free. The panel is
 * `position: fixed` so the sticky sidebar / inspector overflow never clips it.
 */

import { markFor } from "./model-mark.ts";
import { h, injectStyle } from "./section.ts";

const STYLE_ID = "model-picker-style";
const STYLE = `
.mp-btn { display: inline-flex; align-items: center; gap: 7px; font: inherit; font-size: 13px;
  background: var(--surface); color: var(--ink); border: 1px solid var(--border);
  border-radius: 8px; padding: 6px 9px; cursor: pointer; width: 100%; box-sizing: border-box;
  text-align: left; min-height: 32px; }
.mp-btn:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.mp-btn .mp-mark, .mp-item .mp-mark { width: 16px; height: 16px; flex: none; color: var(--ink-soft);
  display: inline-grid; place-items: center; }
.mp-btn .mp-mark svg, .mp-item .mp-mark svg { width: 16px; height: 16px; }
.mp-btn .mp-label { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mp-btn .mp-chevron { flex: none; color: var(--ink-soft); font-size: 10px; }
.mp-panel { position: fixed; z-index: 70; width: 300px; max-height: 340px; overflow: hidden;
  display: flex; flex-direction: column; background: var(--surface-strong); border: 1px solid
  var(--border-strong); border-radius: 12px; box-shadow: var(--shadow); }
.mp-search { font: inherit; font-size: 13px; background: var(--surface-2); color: var(--ink);
  border: none; border-bottom: 1px solid var(--border); padding: 9px 12px; outline: none; }
.mp-list { overflow-y: auto; padding: 4px; }
.mp-group { font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.08em;
  color: var(--ink-soft); padding: 8px 9px 3px; font-weight: 700; }
.mp-item { display: flex; align-items: center; gap: 8px; padding: 6px 9px; border-radius: 8px;
  cursor: pointer; }
.mp-item .mp-name { flex: 1; font-size: 13px; color: var(--ink); overflow: hidden;
  text-overflow: ellipsis; white-space: nowrap; }
.mp-item .mp-meta { flex: none; font-family: var(--mono); font-size: 11px; color: var(--ink-soft); }
.mp-item.active { background: var(--accent-soft); }
.mp-item[aria-selected="true"] .mp-name { font-weight: 700; }
.mp-empty { color: var(--ink-soft); font-size: 12.5px; padding: 10px 12px; }
`;

/** One pickable model row. */
export interface ModelPickerEntry {
  /** The stored value (catalog id or raw runnable flag). Empty = the default. */
  readonly value: string;
  /** Display name (e.g. "Claude Fable 5" or the catalog id). */
  readonly label: string;
  /** Small right-aligned meta (tier, context window). */
  readonly meta?: string;
  /** CLI that serves this model, when known (directory rows). */
  readonly cli?: string;
}

export interface ModelPickerGroup {
  readonly title: string;
  readonly entries: readonly ModelPickerEntry[];
}

export interface ModelPickerOptions {
  /** Accessible name, e.g. "model" / "orchestrator model". */
  readonly label: string;
  readonly value: string;
  /** Label shown (and listed first) for the empty value, e.g. "default routing". */
  readonly defaultLabel: string;
  readonly groups: readonly ModelPickerGroup[];
  onChange(entry: ModelPickerEntry): void;
}

/** The mounted picker: its root element plus a programmatic value setter. */
export interface ModelPickerHandle {
  readonly el: HTMLElement;
  /** Update the shown value without firing `onChange` (e.g. an applied audit). */
  set(value: string): void;
}

/** Render the closed-state button face for the current value. */
function face(button: HTMLButtonElement, value: string, defaultLabel: string): void {
  const mark = value.length > 0 ? markFor(value, null) : null;
  const markHost = h("span", { class: "mp-mark", "aria-hidden": "true" });
  if (mark !== null) markHost.innerHTML = mark.svg;
  button.replaceChildren(
    markHost,
    h("span", { class: "mp-label" }, value.length > 0 ? value : defaultLabel),
    h("span", { class: "mp-chevron", "aria-hidden": "true" }, "▾"),
  );
}

/** Create the picker; append `handle.el` where the select used to be. */
export function createModelPicker(options: ModelPickerOptions): ModelPickerHandle {
  injectStyle(STYLE_ID, STYLE);
  let value = options.value;

  const button = h("button", {
    class: "mp-btn",
    type: "button",
    "aria-label": options.label,
    "aria-haspopup": "listbox",
    "aria-expanded": "false",
  }) as HTMLButtonElement;
  face(button, value, options.defaultLabel);

  const allGroups: ModelPickerGroup[] = [
    { title: "", entries: [{ value: "", label: options.defaultLabel }] },
    ...options.groups,
  ];

  let panel: HTMLElement | null = null;
  let active = -1;
  let visible: { entry: ModelPickerEntry; el: HTMLElement }[] = [];

  const close = (): void => {
    panel?.remove();
    panel = null;
    button.setAttribute("aria-expanded", "false");
    document.removeEventListener("pointerdown", onOutside, true);
    window.removeEventListener("scroll", onScroll, true);
    window.removeEventListener("resize", close);
  };
  const onOutside = (e: Event): void => {
    const target = e.target as Node;
    if (panel !== null && !panel.contains(target) && !button.contains(target)) close();
  };
  const onScroll = (e: Event): void => {
    // Scrolling the page repositions the anchor; scrolling INSIDE the list is fine.
    if (panel !== null && e.target instanceof Node && panel.contains(e.target)) return;
    close();
  };

  const pick = (entry: ModelPickerEntry): void => {
    value = entry.value;
    face(button, value, options.defaultLabel);
    close();
    button.focus();
    options.onChange(entry);
  };

  const setActive = (index: number): void => {
    visible[active]?.el.classList.remove("active");
    active = index;
    const row = visible[active];
    if (row !== undefined) {
      row.el.classList.add("active");
      row.el.scrollIntoView({ block: "nearest" });
    }
  };

  const open = (): void => {
    if (panel !== null) {
      close();
      return;
    }
    const search = h("input", {
      class: "mp-search",
      type: "text",
      placeholder: "search models…",
      "aria-label": `search ${options.label}s`,
    }) as HTMLInputElement;
    const list = h("div", { class: "mp-list", role: "listbox", "aria-label": options.label });

    const render = (filter: string): void => {
      const q = filter.trim().toLowerCase();
      list.replaceChildren();
      visible = [];
      for (const group of allGroups) {
        const hits = group.entries.filter(
          (entry) =>
            q.length === 0 ||
            entry.label.toLowerCase().includes(q) ||
            entry.value.toLowerCase().includes(q),
        );
        if (hits.length === 0) continue;
        if (group.title.length > 0) list.append(h("div", { class: "mp-group" }, group.title));
        for (const entry of hits) {
          const mark = entry.value.length > 0 ? markFor(entry.value, entry.cli ?? null) : null;
          const markHost = h("span", { class: "mp-mark", "aria-hidden": "true" });
          if (mark !== null) markHost.innerHTML = mark.svg;
          const el = h(
            "div",
            {
              class: "mp-item",
              role: "option",
              "aria-selected": entry.value === value ? "true" : "false",
            },
            markHost,
            h("span", { class: "mp-name" }, entry.label),
            entry.meta !== undefined ? h("span", { class: "mp-meta" }, entry.meta) : null,
          );
          el.addEventListener("click", () => pick(entry));
          list.append(el);
          visible.push({ entry, el });
        }
      }
      if (visible.length === 0) list.append(h("div", { class: "mp-empty" }, "no models match"));
      // Land on the current value when listed, else the first row — so a bare
      // Enter always picks the obvious match after filtering.
      const current = visible.findIndex((row) => row.entry.value === value);
      setActive(current >= 0 ? current : visible.length > 0 ? 0 : -1);
    };

    search.addEventListener("input", () => render(search.value));
    search.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const delta = e.key === "ArrowDown" ? 1 : -1;
        const next = Math.min(visible.length - 1, Math.max(0, active + delta));
        setActive(next);
      } else if (e.key === "Enter") {
        e.preventDefault();
        const row = visible[active];
        if (row !== undefined) pick(row.entry);
      } else if (e.key === "Escape") {
        e.preventDefault();
        close();
        button.focus();
      }
    });

    panel = h("div", { class: "mp-panel" }, search, list);
    const at = button.getBoundingClientRect();
    const panelMax = 340;
    const below = window.innerHeight - at.bottom - 12;
    const above = at.top - 12;
    panel.style.left = `${Math.max(8, Math.min(at.left, window.innerWidth - 308))}px`;
    // Open toward the larger side and never taller than the space there.
    if (below >= panelMax || below >= above) {
      panel.style.top = `${at.bottom + 4}px`;
      panel.style.maxHeight = `${Math.min(panelMax, Math.max(120, below))}px`;
    } else {
      panel.style.bottom = `${window.innerHeight - at.top + 4}px`;
      panel.style.maxHeight = `${Math.min(panelMax, Math.max(120, above))}px`;
    }
    document.body.append(panel);
    render("");
    button.setAttribute("aria-expanded", "true");
    // preventScroll + deferred close-listeners: focusing the search (or the
    // opening click itself) must never trip the outside-click/scroll close.
    search.focus({ preventScroll: true });
    window.setTimeout(() => {
      if (panel === null) return;
      document.addEventListener("pointerdown", onOutside, true);
      window.addEventListener("scroll", onScroll, true);
      window.addEventListener("resize", close);
    }, 0);
  };

  button.addEventListener("click", open);
  button.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" && panel === null) {
      e.preventDefault();
      open();
    }
  });

  return {
    el: button,
    set(next: string): void {
      value = next;
      face(button, value, options.defaultLabel);
    },
  };
}

/** "1048576" -> "1M ctx" / "400000" -> "400K ctx" — the row meta for directory models. */
export function contextMeta(contextLength: number | undefined): string | undefined {
  if (contextLength === undefined) return undefined;
  if (contextLength >= 1_000_000) {
    const m = Math.round(contextLength / 100_000) / 10;
    return `${Number.isInteger(m) ? m.toFixed(0) : m.toFixed(1)}M ctx`;
  }
  return `${Math.round(contextLength / 1_000)}K ctx`;
}
