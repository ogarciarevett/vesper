import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "./store.ts";
import type { Store } from "./types.ts";

/** Open a throwaway store in a temp dir and tear it down after `fn`. */
function withStore(fn: (store: Store) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "vesper-ragstore-"));
  const store = openStore(join(dir, "v.db"));
  try {
    fn(store);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

const vec = (...xs: number[]): Float32Array => Float32Array.from(xs);

describe("migration 010_rag_embedding_vector", () => {
  test("rag_documents accepts an embedding BLOB on a fresh (vanilla bun:sqlite) store", () => {
    withStore((store) => {
      expect(store.ragDocumentCount()).toBe(0);
      store.upsertRagDocument({
        sourceKind: "run",
        sourceId: "r1",
        text: "hello",
        embedderId: "test:dim3",
        embedding: vec(0.1, 0.2, 0.3),
      });
      expect(store.ragDocumentCount()).toBe(1);
    });
  });
});

describe("upsertRagDocument + listRagVectors", () => {
  test("round-trips the embedding as a Float32Array with full precision", () => {
    withStore((store) => {
      const embedding = vec(0.123456, -0.654321, 1, 0);
      store.upsertRagDocument({
        sourceKind: "event",
        sourceId: "e1",
        text: "chunk",
        embedderId: "test:dim4",
        embedding,
      });
      const rows = store.listRagVectors();
      expect(rows).toHaveLength(1);
      const row = rows[0];
      if (row === undefined) throw new Error("expected one row");
      expect(row.sourceKind).toBe("event");
      expect(row.sourceId).toBe("e1");
      expect(row.text).toBe("chunk");
      expect(row.dimensions).toBe(4);
      expect(row.embedding).toBeInstanceOf(Float32Array);
      expect(Array.from(row.embedding)).toEqual(Array.from(embedding));
    });
  });

  test("is idempotent on (sourceKind, sourceId, embedderId): re-upsert updates in place", () => {
    withStore((store) => {
      store.upsertRagDocument({
        sourceKind: "skill",
        sourceId: "s1",
        text: "v1",
        embedderId: "test:dim2",
        embedding: vec(1, 0),
      });
      store.upsertRagDocument({
        sourceKind: "skill",
        sourceId: "s1",
        text: "v2",
        embedderId: "test:dim2",
        embedding: vec(0, 1),
      });
      expect(store.ragDocumentCount()).toBe(1);
      const row = store.listRagVectors()[0];
      if (row === undefined) throw new Error("expected one row");
      expect(row.text).toBe("v2");
      expect(Array.from(row.embedding)).toEqual([0, 1]);
    });
  });

  test("a different embedderId for the same source is a distinct row", () => {
    withStore((store) => {
      store.upsertRagDocument({
        sourceKind: "run",
        sourceId: "r1",
        text: "t",
        embedderId: "a",
        embedding: vec(1),
      });
      store.upsertRagDocument({
        sourceKind: "run",
        sourceId: "r1",
        text: "t",
        embedderId: "b",
        embedding: vec(1),
      });
      expect(store.ragDocumentCount()).toBe(2);
    });
  });

  test("filters listRagVectors by sourceKind and embedderId", () => {
    withStore((store) => {
      store.upsertRagDocument({
        sourceKind: "run",
        sourceId: "r1",
        text: "a",
        embedderId: "x",
        embedding: vec(1),
      });
      store.upsertRagDocument({
        sourceKind: "event",
        sourceId: "e1",
        text: "b",
        embedderId: "x",
        embedding: vec(2),
      });
      store.upsertRagDocument({
        sourceKind: "run",
        sourceId: "r2",
        text: "c",
        embedderId: "y",
        embedding: vec(3),
      });
      expect(store.listRagVectors({ sourceKind: "run" })).toHaveLength(2);
      expect(store.listRagVectors({ embedderId: "x" })).toHaveLength(2);
      expect(store.listRagVectors({ sourceKind: "run", embedderId: "y" })).toHaveLength(1);
    });
  });
});

describe("pruneRagDocuments", () => {
  test("deletes by embedderId and returns the number removed", () => {
    withStore((store) => {
      store.upsertRagDocument({
        sourceKind: "run",
        sourceId: "r1",
        text: "a",
        embedderId: "old",
        embedding: vec(1),
      });
      store.upsertRagDocument({
        sourceKind: "run",
        sourceId: "r2",
        text: "b",
        embedderId: "old",
        embedding: vec(2),
      });
      store.upsertRagDocument({
        sourceKind: "run",
        sourceId: "r3",
        text: "c",
        embedderId: "new",
        embedding: vec(3),
      });
      expect(store.pruneRagDocuments({ embedderId: "old" })).toBe(2);
      expect(store.ragDocumentCount()).toBe(1);
      expect(store.listRagVectors()[0]?.text).toBe("c");
    });
  });

  test("scopes deletion to a single source when sourceKind + sourceId given", () => {
    withStore((store) => {
      store.upsertRagDocument({
        sourceKind: "run",
        sourceId: "r1",
        text: "a",
        embedderId: "x",
        embedding: vec(1),
      });
      store.upsertRagDocument({
        sourceKind: "run",
        sourceId: "r2",
        text: "b",
        embedderId: "x",
        embedding: vec(2),
      });
      expect(store.pruneRagDocuments({ sourceKind: "run", sourceId: "r1" })).toBe(1);
      expect(store.ragDocumentCount()).toBe(1);
      expect(store.listRagVectors()[0]?.sourceId).toBe("r2");
    });
  });
});
