import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acceptBest, revertSkill } from "./accept.ts";
import { SkillTrainError } from "./errors.ts";
import { SkillTrainStore } from "./persistence.ts";

// ---------------------------------------------------------------------------
// SkillTrainStore checkpoint methods (real temp dir)
// ---------------------------------------------------------------------------
describe("SkillTrainStore checkpoints", () => {
  let dir: string;
  let store: SkillTrainStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "vesper-ckpt-"));
    store = new SkillTrainStore(dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("readLatestCheckpoint is null before any checkpoint", async () => {
    expect(await store.readLatestCheckpoint("demo")).toBeNull();
    expect(await store.listCheckpoints("demo")).toEqual([]);
  });

  test("writeCheckpoint then readLatestCheckpoint round-trips", async () => {
    const path = await store.writeCheckpoint("demo", "v1 body", 1000);
    expect(path).toBe(join(dir, "demo", "checkpoints", "1000.md"));
    expect(await store.readLatestCheckpoint("demo")).toBe("v1 body");
  });

  test("readLatestCheckpoint returns the highest timestamp (numeric, not lexicographic)", async () => {
    // Multi-magnitude stamps: a lexicographic sort would order these [100, 1000, 2]
    // and wrongly pick "a"; the numeric sort must pick "c".
    await store.writeCheckpoint("demo", "a", 2);
    await store.writeCheckpoint("demo", "b", 100);
    await store.writeCheckpoint("demo", "c", 1000);
    expect(await store.listCheckpoints("demo")).toEqual([2, 100, 1000]);
    expect(await store.readLatestCheckpoint("demo")).toBe("c");
  });

  test("checkpoints are append-only — every prior snapshot file survives (Hard rule 4)", async () => {
    await store.writeCheckpoint("demo", "older", 1000);
    await store.writeCheckpoint("demo", "newer", 2000);
    const ckdir = store.checkpointsDir("demo");
    expect(existsSync(join(ckdir, "1000.md"))).toBe(true);
    expect(existsSync(join(ckdir, "2000.md"))).toBe(true);
    expect(await store.listCheckpoints("demo")).toEqual([1000, 2000]);
  });

  test("a same-timestamp write never clobbers the prior checkpoint (probes the next slot)", async () => {
    const first = await store.writeCheckpoint("demo", "first", 5);
    const second = await store.writeCheckpoint("demo", "second", 5);
    expect(first).not.toBe(second);
    expect(await store.listCheckpoints("demo")).toEqual([5, 6]);
    const ckdir = store.checkpointsDir("demo");
    expect(readFileSync(join(ckdir, "5.md"), "utf8")).toBe("first");
    expect(readFileSync(join(ckdir, "6.md"), "utf8")).toBe("second");
    expect(await store.readLatestCheckpoint("demo")).toBe("second");
  });

  test("listCheckpoints ignores stray non-checkpoint files", async () => {
    await store.writeCheckpoint("demo", "real", 1000);
    const ckdir = store.checkpointsDir("demo");
    writeFileSync(join(ckdir, "notes.txt"), "ignore me", "utf8");
    writeFileSync(join(ckdir, "junk.md"), "non-numeric stem", "utf8");
    expect(await store.listCheckpoints("demo")).toEqual([1000]);
    expect(await store.readLatestCheckpoint("demo")).toBe("real");
  });

  test("checkpointsDir composes under the skill dir", () => {
    expect(store.checkpointsDir("demo")).toBe(join(dir, "demo", "checkpoints"));
  });
});

// ---------------------------------------------------------------------------
// acceptBest / revertSkill (injected deps — no fs, fully deterministic)
// ---------------------------------------------------------------------------
function mem(opts: { committed?: string | null; best?: string | null; checkpoints?: string[] }) {
  let committed = opts.committed ?? null;
  const checkpoints = [...(opts.checkpoints ?? [])].map((body, i) => ({ at: i + 1, body }));
  const deps = {
    name: "demo",
    now: () => 1234,
    readCommitted: async () => committed,
    readBest: async () => opts.best ?? null,
    writeCommitted: async (b: string) => {
      committed = b;
    },
    writeCheckpoint: async (b: string, at: number) => {
      checkpoints.push({ at, body: b });
      return `ckpt-${at}`;
    },
    // NB: the core never sorts — "latest" here is simply last-inserted. Ordering
    // correctness is the store's job (covered by the SkillTrainStore tests above).
    readLatestCheckpoint: async () =>
      checkpoints.length > 0 ? (checkpoints[checkpoints.length - 1]?.body ?? null) : null,
  };
  return { deps, committed: () => committed, checkpoints: () => checkpoints };
}

describe("acceptBest", () => {
  test("adopts best over committed, snapshotting the prior committed first", async () => {
    const h = mem({ committed: "old SKILL", best: "new SKILL" });
    const result = await acceptBest(h.deps);

    expect(result.outcome).toBe("accepted");
    if (result.outcome === "accepted") expect(result.checkpoint).toBe("ckpt-1234");
    expect(h.committed()).toBe("new SKILL");
    // The PRE-WRITE committed bytes are the checkpoint (git-independent rollback).
    expect(h.checkpoints()).toEqual([{ at: 1234, body: "old SKILL" }]);
  });

  test("no_change when committed already equals best (no checkpoint, no write)", async () => {
    const h = mem({ committed: "same", best: "same" });
    const result = await acceptBest(h.deps);

    expect(result.outcome).toBe("no_change");
    expect(h.committed()).toBe("same");
    expect(h.checkpoints()).toEqual([]);
  });

  test("throws no_candidate when there is no trained best.md", async () => {
    const h = mem({ committed: "old", best: null });
    await expect(acceptBest(h.deps)).rejects.toMatchObject({
      reason: "no_candidate",
    });
  });

  test("throws skill_not_found when there is no committed SKILL.md to update", async () => {
    const h = mem({ committed: null, best: "new" });
    await expect(acceptBest(h.deps)).rejects.toBeInstanceOf(SkillTrainError);
    await expect(acceptBest(h.deps)).rejects.toMatchObject({ reason: "skill_not_found" });
  });
});

describe("revertSkill", () => {
  test("restores committed from the latest checkpoint (exact prior bytes)", async () => {
    const h = mem({ committed: "new SKILL", checkpoints: ["old SKILL"] });
    const result = await revertSkill(h.deps);

    expect(result.outcome).toBe("reverted");
    expect(h.committed()).toBe("old SKILL");
  });

  test("no_checkpoint when nothing has been accepted yet", async () => {
    const h = mem({ committed: "current" });
    const result = await revertSkill(h.deps);

    expect(result.outcome).toBe("no_checkpoint");
    expect(h.committed()).toBe("current");
  });

  test("no_change when committed already matches the latest checkpoint", async () => {
    const h = mem({ committed: "old", checkpoints: ["old"] });
    const result = await revertSkill(h.deps);

    expect(result.outcome).toBe("no_change");
    expect(h.committed()).toBe("old");
  });
});

// ---------------------------------------------------------------------------
// Integration: acceptBest + revertSkill over a REAL SkillTrainStore + real files,
// proving exact byte fidelity through utf8 file I/O (the boundary the unit tests stub).
// ---------------------------------------------------------------------------
describe("acceptBest + revertSkill over a real SkillTrainStore (byte fidelity)", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "vesper-evolve-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("accept then revert restores the exact prior bytes (trailing newline, multibyte, blank line)", async () => {
    const store = new SkillTrainStore(join(dir, "state"));
    const committedPath = join(dir, "skills", "demo", "SKILL.md");
    mkdirSync(join(dir, "skills", "demo"), { recursive: true });
    const original = "---\nname: demo\n---\n\n# café ☕\n\nline one\n\nline two\n";
    writeFileSync(committedPath, original, "utf8");
    await store.writeBest("demo", "---\nname: demo\n---\n\n# improved\n");

    const accepted = await acceptBest({
      name: "demo",
      readCommitted: async () => readFileSync(committedPath, "utf8"),
      readBest: async () => store.readBest("demo"),
      writeCommitted: async (body) => writeFileSync(committedPath, body, "utf8"),
      writeCheckpoint: async (body, at) => store.writeCheckpoint("demo", body, at),
      now: () => 1_700_000_000_000,
    });
    expect(accepted.outcome).toBe("accepted");
    expect(readFileSync(committedPath, "utf8")).toBe("---\nname: demo\n---\n\n# improved\n");

    const reverted = await revertSkill({
      name: "demo",
      readCommitted: async () => readFileSync(committedPath, "utf8"),
      readLatestCheckpoint: async () => store.readLatestCheckpoint("demo"),
      writeCommitted: async (body) => writeFileSync(committedPath, body, "utf8"),
    });
    expect(reverted.outcome).toBe("reverted");
    expect(readFileSync(committedPath, "utf8")).toBe(original);
  });
});
