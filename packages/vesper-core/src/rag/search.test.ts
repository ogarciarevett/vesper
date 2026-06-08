import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Capability } from "../capabilities/index.ts";
import { StorageError } from "../storage/errors.ts";
import { openStore } from "../storage/store.ts";
import type { Store } from "../storage/types.ts";
import type { Embedder } from "./embedder.ts";
import { openRagIndex } from "./open.ts";
import { ragSearch, ragStatus } from "./search.ts";

const ALL: readonly Capability[] = ["READ_STORAGE", "NETWORK_FETCH"];

function withStore(fn: (store: Store) => void | Promise<void>): void | Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "vesper-ragsearch-"));
  const store = openStore(join(dir, "v.db"));
  const cleanup = () => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  };
  let result: void | Promise<void>;
  try {
    result = fn(store);
  } catch (err) {
    cleanup();
    throw err;
  }
  if (result instanceof Promise) return result.finally(cleanup);
  cleanup();
  return result;
}

/** An embedder that returns `vec` for every input (so the query vector is deterministic). */
function fixedEmbedder(id: string, vec: Float32Array, onEmbed?: () => void): Embedder {
  return {
    id,
    dimensions: vec.length,
    async embed(texts) {
      onEmbed?.();
      return texts.map(() => vec);
    },
  };
}

const f = (...xs: number[]): Float32Array => Float32Array.from(xs);

describe("ragStatus", () => {
  test("unconfigured -> unavailable with the typed reason", () => {
    expect(ragStatus({ configured: false, indexedDocuments: 0 })).toEqual({
      available: false,
      reason: "rag_unavailable",
      indexedDocuments: 0,
    });
  });

  test("configured + reachable -> available, carrying provider/model/dimensions", () => {
    expect(
      ragStatus({
        configured: true,
        indexedDocuments: 42,
        provider: "ollama",
        model: "nomic-embed-text",
        dimensions: 768,
      }),
    ).toEqual({
      available: true,
      indexedDocuments: 42,
      provider: "ollama",
      model: "nomic-embed-text",
      dimensions: 768,
    });
  });

  test("configured but unreachable -> unavailable", () => {
    expect(ragStatus({ configured: true, reachable: false, indexedDocuments: 5 }).available).toBe(
      false,
    );
  });
});

describe("ragSearch (degradation)", () => {
  test("throws the typed rag_unavailable when no embedder is configured (null index)", async () => {
    let caught: unknown;
    try {
      await ragSearch(null, "anything", 5);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(StorageError);
    expect((caught as StorageError).reason).toBe("rag_unavailable");
  });
});

describe("ragSearch (ranking)", () => {
  test("returns up to k hits ordered by ascending distance (closest first)", async () => {
    await withStore(async (store) => {
      for (const [id, vec] of [
        ["r1", f(1, 0)],
        ["r2", f(0, 1)],
        ["r3", f(1, 1)],
      ] as const) {
        store.upsertRagDocument({
          sourceKind: "run",
          sourceId: id,
          text: id,
          embedderId: "test",
          embedding: vec,
        });
      }
      const index = openRagIndex(store, fixedEmbedder("test", f(1, 0.1)), ALL);
      const hits = await ragSearch(index, "query", 2);
      expect(hits).toHaveLength(2);
      expect(hits[0]?.sourceId).toBe("r1");
      expect(hits[0]?.distance).toBeLessThanOrEqual(hits[1]?.distance ?? Number.POSITIVE_INFINITY);
    });
  });

  test("only scans vectors from the active embedder id", async () => {
    await withStore(async (store) => {
      store.upsertRagDocument({
        sourceKind: "run",
        sourceId: "same",
        text: "same",
        embedderId: "test",
        embedding: f(0, 1),
      });
      store.upsertRagDocument({
        sourceKind: "run",
        sourceId: "other",
        text: "other",
        embedderId: "stale-model",
        embedding: f(1, 0), // would be the closest, but a different embedder
      });
      const index = openRagIndex(store, fixedEmbedder("test", f(1, 0)), ALL);
      const hits = await ragSearch(index, "query", 5);
      expect(hits).toHaveLength(1);
      expect(hits[0]?.sourceId).toBe("same");
    });
  });

  test("pre-filters by sourceKind", async () => {
    await withStore(async (store) => {
      store.upsertRagDocument({
        sourceKind: "run",
        sourceId: "r",
        text: "r",
        embedderId: "test",
        embedding: f(1, 0),
      });
      store.upsertRagDocument({
        sourceKind: "skill",
        sourceId: "s",
        text: "s",
        embedderId: "test",
        embedding: f(1, 0),
      });
      const index = openRagIndex(store, fixedEmbedder("test", f(1, 0)), ALL);
      const hits = await ragSearch(index, "query", 5, { sourceKind: "skill" });
      expect(hits).toHaveLength(1);
      expect(hits[0]?.sourceKind).toBe("skill");
    });
  });

  test("writes a metadata-only audit event", async () => {
    await withStore(async (store) => {
      store.upsertRagDocument({
        sourceKind: "run",
        sourceId: "r",
        text: "r",
        embedderId: "test",
        embedding: f(1, 0),
      });
      const index = openRagIndex(store, fixedEmbedder("test", f(1, 0)), ALL);
      await ragSearch(index, "secret query text", 3);
      const events = store.listEvents({ source: "rag" });
      expect(events).toHaveLength(1);
      expect(events[0]?.kind).toBe("rag_searched");
      expect(JSON.stringify(events[0]?.payload)).not.toContain("secret query text");
    });
  });

  test("refuses before embedding when READ_STORAGE/NETWORK_FETCH is missing", async () => {
    await withStore(async (store) => {
      let embedCalled = false;
      const index = openRagIndex(
        store,
        fixedEmbedder("test", f(1, 0), () => {
          embedCalled = true;
        }),
        ["READ_STORAGE"], // missing NETWORK_FETCH
      );
      await expect(ragSearch(index, "q", 3)).rejects.toThrow();
      expect(embedCalled).toBe(false);
    });
  });
});
