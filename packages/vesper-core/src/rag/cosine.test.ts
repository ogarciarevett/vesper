import { describe, expect, test } from "bun:test";
import { cosineSimilarity } from "./cosine.ts";

const v = (...xs: number[]): Float32Array => Float32Array.from(xs);

describe("cosineSimilarity", () => {
  test("identical vectors score 1", () => {
    expect(cosineSimilarity(v(1, 2, 3), v(1, 2, 3))).toBeCloseTo(1, 6);
  });

  test("orthogonal vectors score 0", () => {
    expect(cosineSimilarity(v(1, 0), v(0, 1))).toBe(0);
  });

  test("opposite vectors score -1", () => {
    expect(cosineSimilarity(v(1, 0), v(-1, 0))).toBeCloseTo(-1, 6);
  });

  test("magnitude does not matter, only direction", () => {
    expect(cosineSimilarity(v(2, 0), v(8, 0))).toBeCloseTo(1, 6);
  });

  test("an all-zero vector yields 0 (undefined direction)", () => {
    expect(cosineSimilarity(v(0, 0, 0), v(1, 2, 3))).toBe(0);
  });

  test("ranks a closer vector above a farther one", () => {
    const query = v(1, 1);
    const near = cosineSimilarity(query, v(1, 0.9));
    const far = cosineSimilarity(query, v(1, -1));
    expect(near).toBeGreaterThan(far);
  });

  test("throws on a dimension mismatch", () => {
    expect(() => cosineSimilarity(v(1, 2), v(1, 2, 3))).toThrow(/dimension mismatch/);
  });
});
