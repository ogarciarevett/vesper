/**
 * The embedding seam — the single point of model choice for RAG (specs/rag-memory.md,
 * "THE CRUX"). An implementation turns text into vectors fully offline (after any one-time
 * weights warm-up). NO implementation ships in this release: the scaffold defines the
 * contract so consumers + the index/search seams compile and degrade to `rag_unavailable`
 * until an on-device model (the proposed default) is authorized and added in an isolated
 * opt-in package — never an LLM provider SDK (Hard rule 12 bans provider *SDKs*, not an
 * embedding-weights download).
 *
 * `id` + `dimensions` are persisted on every `rag_documents` row so a model swap is
 * DETECTABLE and triggers a controlled re-index, never a silent dimension mismatch.
 */
export interface Embedder {
  /** Stable model id, e.g. "local-minilm-l6-v2" — recorded per indexed row. */
  readonly id: string;
  /** Vector width; MUST match the vec0 column width the index was created at. */
  readonly dimensions: number;
  /** Embed a batch of texts. Fully offline after warm-up. */
  embed(texts: readonly string[]): Promise<Float32Array[]>;
}
