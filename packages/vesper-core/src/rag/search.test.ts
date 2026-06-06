import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StorageError } from "../storage/errors.ts";
import { openStore } from "../storage/store.ts";
import { ragSearch, ragStatus } from "./search.ts";

describe("ragStatus", () => {
  test("reports unavailable in this release, surfacing the indexed-document count", () => {
    expect(ragStatus(0)).toEqual({
      available: false,
      reason: "rag_unavailable",
      indexedDocuments: 0,
    });
    expect(ragStatus(42).indexedDocuments).toBe(42);
  });
});

describe("ragSearch (scaffold degradation)", () => {
  test("throws the typed rag_unavailable error so callers degrade gracefully", async () => {
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

describe("migration 009 + ragDocumentCount", () => {
  test("rag_documents exists and is empty on a fresh store", () => {
    const dir = mkdtempSync(join(tmpdir(), "vesper-rag-"));
    const store = openStore(join(dir, "v.db"));
    try {
      expect(store.ragDocumentCount()).toBe(0);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
