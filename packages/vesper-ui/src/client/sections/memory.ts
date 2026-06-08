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
 * Wired to `GET /api/memory` (status) and `GET /api/memory/search` (retrieval). Semantic
 * memory is bring-your-own: the user points Vesper at their own local server (Ollama) or an
 * OpenAI-compatible endpoint via `vesper rag setup`. When no embedder is configured this
 * honestly reports the state and how to enable it; once enabled, a search box queries the
 * index by meaning. Everything stays local — the only call is to the user's own provider.
 */

interface MemoryStatus {
  readonly available: boolean;
  readonly reason?: string;
  readonly indexedDocuments: number;
  readonly provider?: string;
  readonly model?: string;
  readonly dimensions?: number;
}

interface MemoryHit {
  readonly sourceKind: string;
  readonly sourceId: string;
  readonly text: string;
  readonly distance: number;
}

interface MemorySearchResult {
  readonly hits: readonly MemoryHit[];
  readonly available: boolean;
}

const SEARCH_K = 8;

const STYLE_ID = "sec-memory-style";
const STYLE = `
.mem-card { border: 1px solid var(--border); border-radius: 14px; background: var(--surface-2);
  padding: 20px; max-width: 720px; display: flex; flex-direction: column; gap: 14px; }
.mem-badge { align-self: flex-start; }
.mem-lead { font-size: 15px; color: var(--ink); line-height: 1.5; margin: 0; }
.mem-note { font-size: 13px; color: var(--ink-soft); line-height: 1.55; margin: 0; }
.mem-meta { font-family: var(--mono); font-size: 12px; color: var(--ink-soft); margin: 0; }
.mem-search { display: flex; gap: 8px; }
.mem-search .field { flex: 1; }
.mem-hits { display: flex; flex-direction: column; gap: 8px; margin: 0; padding: 0; list-style: none; }
.mem-hit { border: 1px solid var(--border); border-radius: 10px; background: rgba(255, 255, 255, 0.04);
  padding: 10px 12px; display: flex; flex-direction: column; gap: 5px; }
.mem-hit-head { display: flex; align-items: center; gap: 8px; }
.mem-hit-id { font-family: var(--mono); font-size: 11px; color: var(--ink-soft);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mem-hit-score { font-family: var(--mono); font-size: 12px; color: var(--ink-soft); margin-left: auto; }
.mem-hit-text { font-size: 13px; color: var(--ink); line-height: 1.45; margin: 0; word-break: break-word; }
`;

/** Render one search hit as a compact card: source badge, id, similarity, snippet. */
function renderHit(hit: MemoryHit): HTMLElement {
  const similarity = Math.max(0, 1 - hit.distance);
  return h(
    "li",
    { class: "mem-hit" },
    h(
      "div",
      { class: "mem-hit-head" },
      h("span", { class: "badge" }, hit.sourceKind),
      h("span", { class: "mem-hit-id" }, hit.sourceId),
      h(
        "span",
        { class: "mem-hit-score", title: "similarity (1.0 = identical meaning)" },
        similarity.toFixed(3),
      ),
    ),
    h("p", { class: "mem-hit-text" }, hit.text),
  );
}

/** Build the enabled UI: a search form + a live results region. */
function mountEnabled(card: HTMLElement, ctx: SectionContext, status: MemoryStatus): void {
  const input = h("input", {
    class: "field",
    type: "search",
    placeholder: "Search your runs, events, and skills by meaning…",
    "aria-label": "Search memory",
    "aria-controls": "mem-results",
  });
  const button = h("button", { class: "btn primary", type: "submit" }, "Search");
  const results = h("ul", {
    id: "mem-results",
    class: "mem-hits",
    role: "region",
    "aria-live": "polite",
    "aria-label": "Search results",
  });

  const meta = [status.provider, status.model, status.dimensions ? `${status.dimensions}d` : null]
    .filter((part): part is string => typeof part === "string")
    .join(" · ");

  const setMessage = (message: string): void => {
    results.replaceChildren(h("li", { class: "mem-note" }, message));
  };

  const runSearch = async (): Promise<void> => {
    const query = input.value.trim();
    if (query.length === 0) return;
    button.setAttribute("disabled", "");
    setMessage("Searching…");
    try {
      const res = await ctx.api.getJson<MemorySearchResult>(
        `/api/memory/search?q=${encodeURIComponent(query)}&k=${SEARCH_K}`,
      );
      if (!res.available) {
        setMessage("Semantic memory is not enabled.");
      } else if (res.hits.length === 0) {
        setMessage("No matches — try different words, or index more with `vesper rag index`.");
      } else {
        results.replaceChildren(...res.hits.map(renderHit));
      }
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "search failed");
    } finally {
      button.removeAttribute("disabled");
    }
  };

  const form = h(
    "form",
    {
      class: "mem-search",
      onsubmit: (e: Event) => {
        e.preventDefault();
        void runSearch();
      },
    },
    input,
    button,
  );

  card.replaceChildren(
    h("span", { class: "badge ok mem-badge" }, "enabled"),
    form,
    results,
    h(
      "p",
      { class: "mem-meta" },
      `${meta.length > 0 ? `${meta} · ` : ""}${status.indexedDocuments} items indexed`,
    ),
  );
}

/** Build the disabled UI: honest state + the exact command to enable it. */
function mountDisabled(card: HTMLElement, status: MemoryStatus): void {
  card.replaceChildren(
    h("span", { class: "badge mem-badge" }, "not enabled"),
    h(
      "p",
      { class: "mem-lead" },
      "Semantic memory is ready — it just needs an embeddings provider.",
    ),
    h(
      "p",
      { class: "mem-note" },
      "Run `vesper rag setup` to point Vesper at your own local model (Ollama) or an " +
        "OpenAI-compatible endpoint, then `vesper rag index`. Vesper will index your runs, " +
        "events, and skills so you (and your pipelines) can recall them by meaning — not just " +
        "exact matches. Everything stays local; the only call is to the provider you choose.",
    ),
    h("p", { class: "mem-meta" }, `${status.indexedDocuments} items indexed so far`),
  );
}

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

    if (status.available) mountEnabled(card, ctx, status);
    else mountDisabled(card, status);
  },
};
