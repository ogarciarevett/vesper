/**
 * Open a RAG index handle. v2 uses brute-force cosine over inline Float32 vectors, so there is
 * no extension to load and no virtual table to create — opening is just bundling the store,
 * the configured embedder, and the host's granted capabilities into a {@link RagIndex}. When no
 * embedder is configured the host passes `null` and gets `null` back; callers then see
 * `rag_unavailable` from {@link ragSearch}. (A future authorized sqlite-vec path would load the
 * extension here.)
 */

import type { Capability } from "../capabilities/index.ts";
import type { Store } from "../storage/types.ts";
import type { Embedder } from "./embedder.ts";
import type { RagIndex } from "./search.ts";

export function openRagIndex(
  store: Store,
  embedder: Embedder | null,
  granted: readonly Capability[],
): RagIndex | null {
  if (embedder === null) return null;
  return { embedder, store, granted };
}
