// @vesper/core — RAG (semantic memory) seam. Scaffold: the contract + graceful
// degradation; the on-device embedder + sqlite-vec index land later (specs/rag-memory.md).

export type { Embedder } from "./embedder.ts";
export { type RagIndex, type RagStatus, ragSearch, ragStatus } from "./search.ts";
export type { RagDocument, RagHit, RagSourceKind } from "./types.ts";
