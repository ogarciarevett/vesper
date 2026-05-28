import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SkillTrainStore } from "./persistence.ts";
import type { HistoryEntry } from "./types.ts";

function makeEntry(epoch: number, accepted: boolean): HistoryEntry {
  return {
    epoch,
    priorBestScore: 0.5,
    candidateScore: accepted ? 0.7 : 0.4,
    accepted,
    targetCli: "claude",
    optimizerCli: "claude",
    ts: "2026-05-28T00:00:00.000Z",
  };
}

describe("SkillTrainStore", () => {
  let dir: string;
  let store: SkillTrainStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "vesper-skilltrain-"));
    store = new SkillTrainStore(dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("readBest returns null before any training", async () => {
    expect(await store.readBest("demo")).toBeNull();
  });

  test("writeBest then readBest round-trips and creates the dir", async () => {
    await store.writeBest("demo", "best body");
    expect(await store.readBest("demo")).toBe("best body");
  });

  test("appendHistory accumulates JSONL lines in order", async () => {
    await store.appendHistory("demo", makeEntry(1, false));
    await store.appendHistory("demo", makeEntry(2, true));

    const history = await store.readHistory("demo");
    expect(history).toHaveLength(2);
    expect(history[0]?.epoch).toBe(1);
    expect(history[0]?.accepted).toBe(false);
    expect(history[1]?.epoch).toBe(2);
    expect(history[1]?.accepted).toBe(true);
  });

  test("readHistory returns [] when no history exists", async () => {
    expect(await store.readHistory("never-trained")).toEqual([]);
  });

  test("path helpers compose under the base dir", () => {
    expect(store.bestPath("demo")).toBe(join(dir, "demo", "best.md"));
    expect(store.historyPath("demo")).toBe(join(dir, "demo", "history.jsonl"));
  });
});
