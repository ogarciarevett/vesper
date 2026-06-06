/**
 * The RAG retrieval seam + host-facing status. ONE read API (`ragSearch`) that both
 * auto-evolve and the chatbot will call once semantic memory is enabled.
 *
 * This release SCAFFOLDS the seam: no embedder / sqlite-vec extension is wired, so an
 * index cannot be opened and `ragSearch` throws the typed `rag_unavailable` — callers
 * narrow on it and degrade gracefully (the daemon never crashes). `ragStatus` is the
 * non-throwing status the Memory surface renders. The vec0 KNN + indexer land with the
 * embedding model (specs/rag-memory.md, deferred pending Omar's dependency authorization).
 */

import { StorageError } from "../storage/errors.ts";
import type { Embedder } from "./embedder.ts";
import type { RagHit } from "./types.ts";

/** A handle to an open RAG index — produced by the (deferred) `openRagIndex`. Opaque here. */
export interface RagIndex {
  readonly embedder: Embedder;
}

/** Live status of semantic memory on this host (never throws — for the Memory surface). */
export interface RagStatus {
  /** True only once an embedder + sqlite-vec index are wired (false in this release). */
  readonly available: boolean;
  /** Set when unavailable, so the UI can explain the state. */
  readonly reason?: "rag_unavailable";
  /** Indexed `rag_documents` rows (0 until the indexer lands). */
  readonly indexedDocuments: number;
}

/**
 * Report semantic-memory status without throwing. In this release RAG is always
 * unavailable (no embedder/extension); `indexedDocuments` reflects the metadata table
 * (0 today) so the surface can show real progress once indexing lands.
 */
export function ragStatus(indexedDocuments: number): RagStatus {
  return { available: false, reason: "rag_unavailable", indexedDocuments };
}

/**
 * Semantic search over Vesper's indexed history. THE retrieval seam. Throws
 * `StorageError("rag_unavailable")` until an embedding model + sqlite-vec are enabled —
 * the index argument cannot be constructed in this release, so the typed error is the
 * only outcome. Callers MUST catch it and degrade (e.g. fall back to keyword/window scan).
 */
export async function ragSearch(
  index: RagIndex | null,
  _query: string,
  _k: number,
  _opts?: { readonly sourceKind?: RagHit["sourceKind"] },
): Promise<RagHit[]> {
  if (index === null) {
    throw new StorageError("rag_unavailable", "semantic memory is not enabled on this host");
  }
  // An index can only exist once the embedder + vec0 path lands; until then this is
  // unreachable, but kept typed so the deferred slice fills in the KNN here.
  throw new StorageError("rag_unavailable", "the embedding index is not built in this release");
}
