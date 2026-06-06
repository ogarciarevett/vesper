/** Shared types for the RAG (semantic memory) seam. See specs/rag-memory.md. */

/** Which durable surface a RAG document was derived from. */
export type RagSourceKind = "event" | "run" | "run_event" | "skill";

/**
 * One indexed chunk's metadata (the `rag_documents` sidecar row). The vector itself
 * lives in the vec0 virtual table keyed by `vecRowid`; everything human-readable +
 * provenance lives here, mirroring the run_events-vs-runs split.
 */
export interface RagDocument {
  readonly id: string;
  readonly vecRowid: number;
  readonly sourceKind: RagSourceKind;
  readonly sourceId: string;
  /** The chunk that was embedded — kept for display + safe re-embed on a model swap. */
  readonly text: string;
  /** The {@link import("./embedder.ts").Embedder} id used (a change triggers re-index). */
  readonly embedderId: string;
  /** Vector width at index time (guards against a silent dimension mismatch). */
  readonly dimensions: number;
  readonly indexedAt: number;
}

/** One semantic-search result. */
export interface RagHit {
  readonly sourceKind: RagSourceKind;
  readonly sourceId: string;
  readonly text: string;
  /** vec0 distance — smaller is closer. */
  readonly distance: number;
}
