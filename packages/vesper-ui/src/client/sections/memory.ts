/// <reference lib="dom" />
import { ICONS } from "../shell/icons.ts";
import {
  h,
  injectStyle,
  type SectionContext,
  type SectionModule,
  sectionHeader,
} from "../shell/section.ts";

/**
 * Memory — semantic recall over Vesper's own history (specs/rag-memory.md).
 *
 * Wired to `GET /api/memory`. The RAG engine is SCAFFOLDED but not yet enabled (the
 * on-device embedding model is a pending dependency authorization), so this honestly
 * reports the state + what it will do, rather than a dead "coming soon" stub. A search
 * box appears once `available` flips true.
 */

interface MemoryStatus {
  readonly available: boolean;
  readonly reason?: string;
  readonly indexedDocuments: number;
}

const STYLE_ID = "sec-memory-style";
const STYLE = `
.mem-card { border: 1px solid var(--border); border-radius: 14px; background: var(--surface-2);
  padding: 20px; max-width: 640px; display: flex; flex-direction: column; gap: 12px; }
.mem-badge { align-self: flex-start; }
.mem-lead { font-size: 15px; color: var(--ink); line-height: 1.5; margin: 0; }
.mem-note { font-size: 13px; color: var(--ink-soft); line-height: 1.55; margin: 0; }
.mem-stat { font-family: var(--mono); font-size: 13px; color: var(--ink-soft); }
.mem-search { display: flex; gap: 8px; }
.mem-search .field { flex: 1; }
`;

export const memorySection: SectionModule = {
  id: "memory",
  title: "Memory",
  group: "vesper",
  glyph: ICONS.memory,
  async mount(host: HTMLElement, ctx: SectionContext) {
    injectStyle(STYLE_ID, STYLE);
    host.append(
      sectionHeader("Memory", "What Vesper can recall across runs — searchable by meaning."),
    );

    const card = h("div", { class: "mem-card" }, h("p", { class: "mem-note" }, "Loading…"));
    host.append(card);

    let status: MemoryStatus;
    try {
      status = await ctx.api.getJson<MemoryStatus>("/api/memory");
    } catch (err) {
      card.replaceChildren(
        h("p", { class: "mem-note" }, err instanceof Error ? err.message : "could not load memory"),
      );
      return;
    }

    if (status.available) {
      // Future: semantic search box (lights up once an embedder is enabled).
      const input = h("input", {
        class: "field",
        type: "search",
        placeholder: "Search your runs, events, and skills by meaning…",
        "aria-label": "Search memory",
      });
      card.replaceChildren(
        h("span", { class: "badge ok mem-badge" }, "enabled"),
        h(
          "div",
          { class: "mem-search" },
          input,
          h("button", { class: "btn primary", type: "button" }, "Search"),
        ),
        h("p", { class: "mem-stat" }, `${status.indexedDocuments} items indexed`),
      );
      return;
    }

    // Scaffolded but disabled — honest state + what it will do.
    card.replaceChildren(
      h("span", { class: "badge mem-badge" }, "not enabled yet"),
      h("p", { class: "mem-lead" }, "Semantic memory is scaffolded but not turned on yet."),
      h(
        "p",
        { class: "mem-note" },
        "Once Vesper's on-device embedding model is enabled, it will index your runs, events, " +
          "and skills so you (and your pipelines) can recall them by meaning — not just exact " +
          "matches. Everything stays local; nothing is sent to a cloud service.",
      ),
      h("p", { class: "mem-stat" }, `${status.indexedDocuments} items indexed so far`),
    );
  },
};
