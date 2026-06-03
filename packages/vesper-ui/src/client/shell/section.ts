/// <reference lib="dom" />

/** Sidebar grouping for a section (the three sidebar headers). */
export type SectionGroup = "primary" | "vesper" | "computer";

/** Thin JSON fetch client for sections (all requests are same-origin/local). */
export interface ApiClient {
  getJson<T>(path: string): Promise<T>;
  postJson<T>(path: string, body?: unknown, headers?: Record<string, string>): Promise<T>;
  putJson<T>(path: string, body?: unknown, headers?: Record<string, string>): Promise<T>;
}

/** A frame received on the shared `/api/live` socket (sections narrow by `type`). */
export interface LiveMessage {
  readonly type?: string;
  readonly [key: string]: unknown;
}

/** Add/remove/emit listeners for `/api/live` frames (owned by the shell, not a section). */
export interface LiveBus {
  add(handler: (msg: LiveMessage) => void): void;
  remove(handler: (msg: LiveMessage) => void): void;
  emit(msg: LiveMessage): void;
}

/** Everything a section is handed when it mounts. */
export interface SectionContext {
  readonly api: ApiClient;
  /** Surface a transient message via the shared toast. */
  readonly toast: (message: string) => void;
  /** Send a control frame on the shared `/api/live` socket (no-op when closed). */
  readonly wsSend: (payload: Record<string, unknown>) => void;
  /** Subscribe to live `/api/live` frames; auto-removed when the section unmounts. */
  onLive(handler: (msg: LiveMessage) => void): void;
  /** Register a cleanup fn run when the section unmounts (timers, subscriptions). */
  onCleanup(fn: () => void): void;
}

/**
 * A navigable section of the app shell. Each section owns its own markup and
 * injects its own scoped `<style>` (via {@link injectStyle}) so sections are
 * file-disjoint — they never touch a shared stylesheet. The router mounts exactly
 * one section into the content host at a time.
 */
export interface SectionModule {
  /** Stable route key + sidebar id (e.g. "runtime"). */
  readonly id: string;
  /** Sidebar + header label (e.g. "Runtime"). */
  readonly title: string;
  readonly group: SectionGroup;
  /** Inline SVG markup for the sidebar glyph (24x24, uses currentColor/gradients). */
  readonly glyph: string;
  /** Render into `host`. May be async; the router awaits it. */
  mount(host: HTMLElement, ctx: SectionContext): void | Promise<void>;
}

/** Install a `<style>` once per id — idempotent, so re-mounting a section is cheap. */
export function injectStyle(id: string, css: string): void {
  if (document.getElementById(id) !== null) return;
  const style = document.createElement("style");
  style.id = id;
  style.textContent = css;
  document.head.append(style);
}

type Child = Node | string | null | undefined | false;

/** Tiny hyperscript helper — `h("div", { class: "x" }, "hi")`. Keeps sections terse. */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props?: Record<string, string | number | boolean | EventListener | null> | null,
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (props) {
    for (const [key, value] of Object.entries(props)) {
      if (value === null || value === false) continue;
      if (key === "class") node.className = String(value);
      else if (key === "html") node.innerHTML = String(value);
      else if (key.startsWith("on") && typeof value === "function") {
        node.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
      } else if (typeof value === "boolean") {
        if (value) node.setAttribute(key, "");
      } else {
        node.setAttribute(key, String(value));
      }
    }
  }
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    node.append(typeof child === "string" ? document.createTextNode(child) : child);
  }
  return node;
}

/** Build a section's standard header (title + optional subtitle). */
export function sectionHeader(title: string, subtitle?: string): HTMLElement {
  return h(
    "header",
    { class: "sec-head" },
    h("h1", { class: "sec-title" }, title),
    subtitle ? h("p", { class: "sec-sub" }, subtitle) : null,
  );
}
