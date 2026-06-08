/**
 * Cosine similarity between two equal-length vectors, in the range [-1, 1] (1 = identical
 * direction, 0 = orthogonal, -1 = opposite). Returns 0 when either vector is all-zeros (its
 * direction is undefined). Throws on a dimension mismatch — a silent wrong answer is worse than
 * a loud failure. This is the ranking primitive for the brute-force RAG search (no sqlite-vec).
 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) {
    throw new Error(`cosineSimilarity: dimension mismatch (${a.length} vs ${b.length})`);
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    // Indices are in range (equal lengths), but noUncheckedIndexedAccess types these as
    // number | undefined; `?? 0` is a no-op for valid entries and keeps the loop type-clean.
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
