import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Capability } from "../capabilities/index.ts";
import { openStore } from "../storage/store.ts";
import type { Store } from "../storage/types.ts";
import type { Embedder } from "./embedder.ts";
import { backfill, indexDocument, MAX_CHUNK_CHARS } from "./indexer.ts";
import { openRagIndex } from "./open.ts";

const ALL: readonly Capability[] = ["READ_STORAGE", "WRITE_STORAGE", "NETWORK_FETCH"];

async function withStore(fn: (store: Store) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "vesper-ragindex-"));
  const store = openStore(join(dir, "v.db"));
  try {
    await fn(store);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

function recordingEmbedder(id = "idx"): { embedder: Embedder; embedded: string[] } {
  const embedded: string[] = [];
  const embedder: Embedder = {
    id,
    dimensions: 2,
    async embed(texts) {
      embedded.push(...texts);
      return texts.map(() => Float32Array.from([1, 0]));
    },
  };
  return { embedder, embedded };
}

/** Seed one event, one run (with summary), one run-event => 3 indexable docs. */
function seedThree(store: Store): void {
  store.appendEvent({ source: "test", kind: "k", payload: { a: 1 } });
  const runId = store.recordRun({ pipeline: "p", status: "ok", summary: "a run summary" });
  store.appendRunEvent({ runId, kind: "log", payload: { m: "hi" } });
}

describe("indexDocument", () => {
  test("embeds + upserts one source and truncates to MAX_CHUNK_CHARS", async () => {
    await withStore(async (store) => {
      const { embedder, embedded } = recordingEmbedder();
      const index = openRagIndex(store, embedder, ALL);
      if (index === null) throw new Error("index");
      await indexDocument(index, {
        sourceKind: "skill",
        sourceId: "big",
        text: "x".repeat(5000),
      });
      expect(store.ragDocumentCount()).toBe(1);
      expect(embedded[0]?.length).toBe(MAX_CHUNK_CHARS);
      expect(store.listRagVectors()[0]?.text.length).toBe(MAX_CHUNK_CHARS);
    });
  });

  test("refuses without WRITE_STORAGE", async () => {
    await withStore(async (store) => {
      const index = openRagIndex(store, recordingEmbedder().embedder, ["READ_STORAGE"]);
      if (index === null) throw new Error("index");
      await expect(
        indexDocument(index, { sourceKind: "skill", sourceId: "s", text: "t" }),
      ).rejects.toThrow();
      expect(store.ragDocumentCount()).toBe(0);
    });
  });
});

describe("backfill", () => {
  test("indexes events + runs + run_events from the store", async () => {
    await withStore(async (store) => {
      seedThree(store);
      const index = openRagIndex(store, recordingEmbedder().embedder, ALL);
      if (index === null) throw new Error("index");
      const result = await backfill(index);
      expect(result).toEqual({ indexed: 3, skipped: 0, total: 3 });
      expect(store.ragDocumentCount()).toBe(3);
    });
  });

  test("skips already-current sources on a second run", async () => {
    await withStore(async (store) => {
      seedThree(store);
      const index = openRagIndex(store, recordingEmbedder().embedder, ALL);
      if (index === null) throw new Error("index");
      await backfill(index);
      const second = await backfill(index);
      // The rag_indexed audit row written by the first backfill must NOT be indexed.
      expect(second).toEqual({ indexed: 0, skipped: 3, total: 3 });
      expect(store.ragDocumentCount()).toBe(3);
    });
  });

  test("rebuild prunes the active embedder then re-indexes", async () => {
    await withStore(async (store) => {
      seedThree(store);
      const index = openRagIndex(store, recordingEmbedder().embedder, ALL);
      if (index === null) throw new Error("index");
      await backfill(index);
      const rebuilt = await backfill(index, { rebuild: true });
      expect(rebuilt).toEqual({ indexed: 3, skipped: 0, total: 3 });
      expect(store.ragDocumentCount()).toBe(3);
    });
  });

  test("indexes host-supplied extra documents (skills)", async () => {
    await withStore(async (store) => {
      const index = openRagIndex(store, recordingEmbedder().embedder, ALL);
      if (index === null) throw new Error("index");
      const result = await backfill(index, {
        extraDocuments: [{ sourceKind: "skill", sourceId: "my-skill", text: "skill body" }],
      });
      expect(result.indexed).toBe(1);
      expect(store.listRagVectors({ sourceKind: "skill" })).toHaveLength(1);
    });
  });

  test("writes a metadata-only rag_indexed audit event", async () => {
    await withStore(async (store) => {
      seedThree(store);
      const index = openRagIndex(store, recordingEmbedder().embedder, ALL);
      if (index === null) throw new Error("index");
      await backfill(index);
      const events = store.listEvents({ source: "rag" });
      expect(events).toHaveLength(1);
      expect(events[0]?.kind).toBe("rag_indexed");
    });
  });

  test("refuses without WRITE_STORAGE", async () => {
    await withStore(async (store) => {
      seedThree(store);
      const index = openRagIndex(store, recordingEmbedder().embedder, ["READ_STORAGE"]);
      if (index === null) throw new Error("index");
      await expect(backfill(index)).rejects.toThrow();
      expect(store.ragDocumentCount()).toBe(0);
    });
  });
});
