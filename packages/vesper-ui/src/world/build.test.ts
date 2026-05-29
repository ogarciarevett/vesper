import { describe, expect, test } from "bun:test";
import { buildWorld } from "./build.ts";
import type { PipelineInfo, RunInfo, WorldSnapshot } from "./types.ts";

const PIPELINES: PipelineInfo[] = [
  { id: "echo", label: "echo", enabled: true, kind: "manual" },
  { id: "skill-train", label: "skill-train", enabled: true, kind: "manual" },
];

function snap(runs: RunInfo[], seed = "seed-A"): WorldSnapshot {
  return { pipelines: PIPELINES, runs, seed };
}

describe("buildWorld", () => {
  test("one inhabitant per pipeline, idle with no runs", () => {
    const scene = buildWorld(snap([]));
    expect(scene.inhabitants).toHaveLength(2);
    expect(scene.inhabitants.every((i) => i.mood === "idle")).toBe(true);
    expect(scene.totalRuns).toBe(0);
    expect(scene.liveliness).toBe(0);
  });

  test("is deterministic for the same snapshot + seed", () => {
    const a = buildWorld(snap([{ pipeline: "echo", status: "ok", summary: "x", ts: 1 }]));
    const b = buildWorld(snap([{ pipeline: "echo", status: "ok", summary: "x", ts: 1 }]));
    expect(a).toEqual(b);
  });

  test("different seeds move inhabitants (unique per machine)", () => {
    const a = buildWorld(snap([], "seed-A")).inhabitants[0];
    const b = buildWorld(snap([], "seed-B")).inhabitants[0];
    expect([a?.x, a?.y]).not.toEqual([b?.x, b?.y]);
    expect(a?.avatarSeed).not.toBe(b?.avatarSeed);
  });

  test("mood comes from the most recent run", () => {
    const scene = buildWorld(
      snap([
        { pipeline: "echo", status: "ok", summary: "older", ts: 1 },
        { pipeline: "echo", status: "error", summary: "newest", ts: 5 },
      ]),
    );
    const echo = scene.inhabitants.find((i) => i.id === "echo");
    expect(echo?.mood).toBe("error");
    expect(echo?.lastSummary).toBe("newest");
    expect(echo?.runCount).toBe(2);
  });

  test("no_change status maps to its own mood", () => {
    const scene = buildWorld(
      snap([{ pipeline: "echo", status: "no_change", summary: "s", ts: 1 }]),
    );
    expect(scene.inhabitants.find((i) => i.id === "echo")?.mood).toBe("no_change");
  });

  test("prominence is proportional to run share; busiest is most prominent", () => {
    const runs: RunInfo[] = [
      { pipeline: "echo", status: "ok", summary: "1", ts: 1 },
      { pipeline: "echo", status: "ok", summary: "2", ts: 2 },
      { pipeline: "echo", status: "ok", summary: "3", ts: 3 },
      { pipeline: "skill-train", status: "ok", summary: "1", ts: 4 },
    ];
    const scene = buildWorld(snap(runs));
    const echo = scene.inhabitants.find((i) => i.id === "echo");
    const st = scene.inhabitants.find((i) => i.id === "skill-train");
    expect(echo?.prominence).toBe(1); // busiest -> full prominence
    expect(st?.prominence).toBeLessThan(echo?.prominence ?? 0);
    expect(st?.prominence).toBeGreaterThanOrEqual(0.35); // never invisible
  });

  test("disabled pipelines read as idle even with runs", () => {
    const scene = buildWorld({
      pipelines: [{ id: "echo", label: "echo", enabled: false, kind: "manual" }],
      runs: [{ pipeline: "echo", status: "ok", summary: "s", ts: 1 }],
      seed: "s",
    });
    expect(scene.inhabitants[0]?.mood).toBe("idle");
  });

  test("positions stay within the canvas margins", () => {
    const many: PipelineInfo[] = Array.from({ length: 9 }, (_, i) => ({
      id: `p${i}`,
      label: `p${i}`,
      enabled: true,
      kind: "manual",
    }));
    const scene = buildWorld({ pipelines: many, runs: [], seed: "grid" });
    for (const i of scene.inhabitants) {
      expect(i.x).toBeGreaterThanOrEqual(0.08);
      expect(i.x).toBeLessThanOrEqual(0.92);
      expect(i.y).toBeGreaterThanOrEqual(0.08);
      expect(i.y).toBeLessThanOrEqual(0.92);
    }
  });

  test("liveliness grows with total runs and caps at 1", () => {
    const mk = (k: number): RunInfo[] =>
      Array.from({ length: k }, (_, i) => ({
        pipeline: "echo",
        status: "ok",
        summary: "s",
        ts: i,
      }));
    expect(buildWorld(snap(mk(10))).liveliness).toBeCloseTo(0.5, 5);
    expect(buildWorld(snap(mk(50))).liveliness).toBe(1);
  });
});

describe("buildWorld — live presences", () => {
  const withPresence = (): WorldSnapshot => ({
    pipelines: PIPELINES,
    runs: [],
    seed: "seed-A",
    presences: [
      { id: "claude-cli", label: "Claude Code", kind: "cli", since: "18:10", procCount: 7 },
    ],
  });

  test("adds a live inhabitant per presence, alongside the pipelines", () => {
    const scene = buildWorld(withPresence());
    expect(scene.inhabitants).toHaveLength(PIPELINES.length + 1);
    const live = scene.inhabitants.find((i) => i.id === "presence:claude-cli");
    expect(live).toBeDefined();
    expect(live?.live).toBe(true);
    expect(live?.label).toBe("Claude Code");
    expect(live?.liveSince).toBe("18:10");
  });

  test("pipeline inhabitants are not live", () => {
    const scene = buildWorld(withPresence());
    for (const i of scene.inhabitants.filter((x) => !x.id.startsWith("presence:"))) {
      expect(i.live).toBe(false);
      expect(i.liveSince).toBeNull();
    }
  });

  test("presence inhabitants float in the upper band and stay on-canvas", () => {
    const live = buildWorld(withPresence()).inhabitants.find((i) => i.live);
    expect(live?.y).toBeGreaterThanOrEqual(0.12);
    expect(live?.y).toBeLessThanOrEqual(0.4);
    expect(live?.x).toBeGreaterThanOrEqual(0.08);
    expect(live?.x).toBeLessThanOrEqual(0.92);
  });

  test("a running agent raises liveliness even with zero runs", () => {
    expect(buildWorld({ pipelines: PIPELINES, runs: [], seed: "s" }).liveliness).toBe(0);
    expect(buildWorld(withPresence()).liveliness).toBeGreaterThan(0);
  });

  test("presence position is stable per agent id (seeded), independent of count", () => {
    const one = buildWorld(withPresence()).inhabitants.find((i) => i.id === "presence:claude-cli");
    const two = buildWorld({
      ...withPresence(),
      presences: [
        { id: "codex-app", label: "Codex (desktop)", kind: "app", since: "01:00", procCount: 1 },
        { id: "claude-cli", label: "Claude Code", kind: "cli", since: "18:10", procCount: 7 },
      ],
    }).inhabitants.find((i) => i.id === "presence:claude-cli");
    expect([one?.x, one?.y]).toEqual([two?.x, two?.y]);
  });

  test("no presences field behaves exactly as before (back-compat)", () => {
    const a = buildWorld({ pipelines: PIPELINES, runs: [], seed: "s" });
    const b = buildWorld({ pipelines: PIPELINES, runs: [], seed: "s", presences: [] });
    expect(a).toEqual(b);
    expect(a.inhabitants.every((i) => !i.live)).toBe(true);
  });
});
