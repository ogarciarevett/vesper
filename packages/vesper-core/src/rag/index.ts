// @vesper/core — RAG (semantic memory) seam. Brute-force cosine KNN over inline Float32
// vectors with a bring-your-own HTTP embedder (Ollama / OpenAI-compatible) — no sqlite-vec,
// no provider SDK, no new dependency (specs/rag-memory.md).

export { cosineSimilarity } from "./cosine.ts";
export type { Embedder } from "./embedder.ts";
export {
  type EmbedderFormat,
  type HttpEmbedderOptions,
  makeHttpEmbedder,
} from "./embedders/http.ts";
export {
  type BackfillOptions,
  type BackfillResult,
  backfill,
  gatherStoreDocuments,
  indexDocument,
  indexRun,
  MAX_CHUNK_CHARS,
  type RagSourceDoc,
} from "./indexer.ts";
export { openRagIndex } from "./open.ts";
export {
  type RagIndex,
  type RagSearchOptions,
  type RagStatus,
  type RagStatusInput,
  ragSearch,
  ragStatus,
} from "./search.ts";
export type { RagDocument, RagHit, RagSourceKind } from "./types.ts";
