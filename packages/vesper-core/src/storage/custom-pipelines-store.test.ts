import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "./store.ts";
import type { Store } from "./types.ts";

/**
 * Migration 013_custom_pipelines + the Store CRUD surface (specs/pipeline-editor.md,
 * task 1). Custom pipelines are DATA: a versioned doc the editor saves. Delete is
 * an archive (status flip), never a row removal — Hard rule 4.
 */
describe("custom pipelines store", () => {
  let dir: string;
  let store: Store;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "vesper-custom-pipelines-"));
    store = openStore(join(dir, "test.db"));
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const doc = (name: string): Record<string, unknown> => ({
    v: 1,
    name,
    stages: [{ tasks: [{ kind: "prompt", id: "a", title: "A", prompt: "hello" }] }],
  });

  it("upsert inserts a new active row at revision 1 and round-trips the doc", () => {
    store.upsertCustomPipeline({ id: "morning-brief", name: "Morning brief", doc: doc("m") });

    const row = store.getCustomPipeline("morning-brief");
    expect(row).not.toBeNull();
    expect(row?.id).toBe("morning-brief");
    expect(row?.name).toBe("Morning brief");
    expect(row?.revision).toBe(1);
    expect(row?.status).toBe("active");
    expect(row?.doc).toEqual(doc("m"));
    expect(row?.tsCreated).toBeGreaterThan(0);
    expect(row?.tsUpdated).toBe(row?.tsCreated as number);
  });

  it("upsert on an existing id bumps revision + tsUpdated and keeps tsCreated", async () => {
    store.upsertCustomPipeline({ id: "p", name: "P", doc: doc("one") });
    const first = store.getCustomPipeline("p");
    await new Promise((resolve) => setTimeout(resolve, 2));

    store.upsertCustomPipeline({ id: "p", name: "P renamed", doc: doc("two") });
    const second = store.getCustomPipeline("p");

    expect(second?.revision).toBe(2);
    expect(second?.name).toBe("P renamed");
    expect(second?.doc).toEqual(doc("two"));
    expect(second?.tsCreated).toBe(first?.tsCreated as number);
    expect(second?.tsUpdated).toBeGreaterThan(first?.tsUpdated as number);
  });

  it("getCustomPipeline returns null for an unknown id", () => {
    expect(store.getCustomPipeline("nope")).toBeNull();
  });

  it("archive flips status (never deletes) and returns false for unknown ids", () => {
    store.upsertCustomPipeline({ id: "p", name: "P", doc: doc("p") });

    expect(store.archiveCustomPipeline("p")).toBe(true);
    const row = store.getCustomPipeline("p");
    expect(row?.status).toBe("archived");
    expect(row?.doc).toEqual(doc("p"));

    expect(store.archiveCustomPipeline("missing")).toBe(false);
  });

  it("saving an archived pipeline restores it to active", () => {
    store.upsertCustomPipeline({ id: "p", name: "P", doc: doc("p") });
    store.archiveCustomPipeline("p");

    store.upsertCustomPipeline({ id: "p", name: "P", doc: doc("p2") });
    const row = store.getCustomPipeline("p");
    expect(row?.status).toBe("active");
    expect(row?.revision).toBe(2);
  });

  it("list filters by status and orders newest-updated first", async () => {
    store.upsertCustomPipeline({ id: "a", name: "A", doc: doc("a") });
    await new Promise((resolve) => setTimeout(resolve, 2));
    store.upsertCustomPipeline({ id: "b", name: "B", doc: doc("b") });
    await new Promise((resolve) => setTimeout(resolve, 2));
    store.archiveCustomPipeline("a");

    const active = store.listCustomPipelines({ status: "active" });
    expect(active.map((r) => r.id)).toEqual(["b"]);

    const archived = store.listCustomPipelines({ status: "archived" });
    expect(archived.map((r) => r.id)).toEqual(["a"]);

    const all = store.listCustomPipelines();
    expect(all).toHaveLength(2);
    // "a" was archived (updated) after "b" was saved -> newest-updated first.
    expect(all[0]?.id).toBe("a");
  });

  it("rejects a doc that does not serialize to an object row", () => {
    // Defensive: the store persists whatever object it is given; structural
    // validation lives in the PipelineDoc parser, not here. The store only
    // guarantees the round-trip.
    const weird: Record<string, unknown> = { v: 1, nested: { deep: [1, "two", null] } };
    store.upsertCustomPipeline({ id: "w", name: "W", doc: weird });
    expect(store.getCustomPipeline("w")?.doc).toEqual(weird);
  });
});
