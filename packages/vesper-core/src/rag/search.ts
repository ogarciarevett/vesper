/**
 * The RAG retrieval seam + host-facing status. ONE read API (`ragSearch`) that the CLI,
 * the Memory UI, and (later) auto-evolve / chatbot grounding all call.
 *
 * v2 (specs/rag-memory.md): real brute-force cosine KNN over inline Float32 vectors — NO
 * sqlite-vec. `ragSearch` embeds the query via the configured {@link Embedder}, scans the
 * same-embedder vectors from the store, ranks them by cosine, and returns the top-k. When no
 * embedder is configured the index is `null` and `ragSearch` throws the typed `rag_unavailable`
 * so callers degrade gracefully (the daemon never crashes). `ragStatus` is the non-throwing
 * status the Memory surface renders.
 */

import { assertCapabilities, type Capability } from "../capabilities/index.ts";
import { StorageError } from "../storage/errors.ts";
import type { Store } from "../storage/types.ts";
import { cosineSimilarity } from "./cosine.ts";
import type { Embedder } from "./embedder.ts";
import type { RagHit, RagSourceKind } from "./types.ts";

/** A handle to an open RAG index — produced by {@link import("./open.ts").openRagIndex}. */
export interface RagIndex {
  readonly embedder: Embedder;
  readonly store: Store;
  /** Capabilities the host granted; asserted at search/index time. */
  readonly granted: readonly Capability[];
}

/** Live status of semantic memory on this host (never throws — for the Memory surface). */
export interface RagStatus {
  /** True when an embedder is configured and (if probed) reachable. */
  readonly available: boolean;
  /** Set when unavailable, so the UI can explain the state. */
  readonly reason?: "rag_unavailable";
  /** Indexed `rag_documents` rows. */
  readonly indexedDocuments: number;
  readonly provider?: string;
  readonly model?: string;
  readonly dimensions?: number;
}

/** Inputs the host gathers to describe semantic-memory status. */
export interface RagStatusInput {
  /** Is an embedder configured (provider resolved)? */
  readonly configured: boolean;
  /** Optional reachability probe result; `false` forces unavailable. */
  readonly reachable?: boolean;
  readonly indexedDocuments: number;
  readonly provider?: string;
  readonly model?: string;
  readonly dimensions?: number;
}

/** Build a non-throwing status snapshot for the Memory surface. */
export function ragStatus(input: RagStatusInput): RagStatus {
  const available = input.configured && input.reachable !== false;
  return {
    available,
    indexedDocuments: input.indexedDocuments,
    ...(available ? {} : { reason: "rag_unavailable" as const }),
    ...(input.provider !== undefined ? { provider: input.provider } : {}),
    ...(input.model !== undefined ? { model: input.model } : {}),
    ...(input.dimensions !== undefined ? { dimensions: input.dimensions } : {}),
  };
}

/** Options for {@link ragSearch}. */
export interface RagSearchOptions {
  readonly sourceKind?: RagSourceKind;
}

/**
 * Semantic search over Vesper's indexed history. THE retrieval seam. Throws
 * `StorageError("rag_unavailable")` when no embedder is configured (`index === null`).
 * Otherwise asserts `READ_STORAGE` + `NETWORK_FETCH`, embeds the query, brute-force
 * cosine-ranks the active embedder's vectors, and returns up to `k` hits (ascending
 * `distance` = 1 - cosine, so smaller is closer).
 */
export async function ragSearch(
  index: RagIndex | null,
  query: string,
  k: number,
  opts?: RagSearchOptions,
): Promise<RagHit[]> {
  if (index === null) {
    throw new StorageError("rag_unavailable", "semantic memory is not enabled on this host");
  }
  assertCapabilities(["READ_STORAGE", "NETWORK_FETCH"], index.granted);
  if (k <= 0) return [];

  const [queryVec] = await index.embedder.embed([query]);
  if (queryVec === undefined) return [];

  const rows = index.store.listRagVectors(
    opts?.sourceKind !== undefined
      ? { embedderId: index.embedder.id, sourceKind: opts.sourceKind }
      : { embedderId: index.embedder.id },
  );

  const hits: RagHit[] = rows
    .filter((row) => row.embedding.length === queryVec.length)
    .map((row) => ({
      sourceKind: row.sourceKind,
      sourceId: row.sourceId,
      text: row.text,
      distance: 1 - cosineSimilarity(queryVec, row.embedding),
    }));
  hits.sort((a, b) => a.distance - b.distance);
  const top = hits.slice(0, k);

  // Audit at metadata granularity only — never the query text or hit bodies.
  index.store.appendEvent({
    source: "rag",
    kind: "rag_searched",
    payload: {
      k,
      returned: top.length,
      scanned: rows.length,
      embedderId: index.embedder.id,
      ...(opts?.sourceKind !== undefined ? { sourceKind: opts.sourceKind } : {}),
    },
  });

  return top;
}
