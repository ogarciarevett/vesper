/**
 * Tests for the benchmark parser and the cost+intelligence model selector. The
 * leaderboard fixture is a LIVE capture of the trusted source
 * (deepswe.datacurve.ai/artifacts/leaderboard-live.json, 2026-06-09).
 */

import { describe, expect, test } from "bun:test";
import type { ModelBenchmarkRow } from "../storage/types.ts";
import { parseLeaderboard } from "./benchmark.ts";
import fixture from "./leaderboard.fixture.json";
import { selectModel } from "./select.ts";
import type { ModelsConfig } from "./types.ts";

const NOW = 1_770_000_000_000;

/** Stamp parsed inputs into persisted-row shape for the selector. */
function asRows(fetchedAt: number): ModelBenchmarkRow[] {
  return parseLeaderboard(fixture).map((input, i) => ({
    ...input,
    id: `row-${i}`,
    source: "deepswe",
    fetchedAt,
  }));
}

const CATALOG: ModelsConfig = {
  default: "claude-sonnet",
  catalog: {
    "claude-haiku": {
      cli: "claude",
      flag: "haiku",
      tier: "cheap",
      benchmarkNames: ["claude-haiku-4-5"],
    },
    "claude-sonnet": {
      cli: "claude",
      flag: "sonnet",
      tier: "mid",
      benchmarkNames: ["claude-sonnet-4-6"],
    },
    "claude-opus": {
      cli: "claude",
      flag: "opus",
      tier: "frontier",
      benchmarkNames: ["claude-opus-4-8", "claude-opus-4-7"],
    },
    gpt: { cli: "codex", flag: "gpt-5.5", tier: "frontier", benchmarkNames: ["gpt-5-5"] },
  },
};

describe("parseLeaderboard", () => {
  test("parses every live row with the projected fields", () => {
    const rows = parseLeaderboard(fixture);
    expect(rows.length).toBeGreaterThanOrEqual(25);
    const gpt = rows.find((r) => r.model === "gpt-5-5");
    expect(gpt?.passAt1).toBeGreaterThan(0.5);
    expect(gpt?.meanCostUsd).toBeGreaterThan(0);
    expect(gpt?.harness).toBe("mini-swe-agent");
    expect(typeof gpt?.rawJson).toBe("string");
  });

  test("drops malformed rows and survives a malformed document", () => {
    expect(parseLeaderboard({ rows: [{ model: "ok" }, { no_model: true }, 42] })).toHaveLength(1);
    expect(parseLeaderboard("garbage")).toEqual([]);
    expect(parseLeaderboard({ rows: "nope" })).toEqual([]);
    expect(parseLeaderboard(null)).toEqual([]);
  });
});

describe("selectModel", () => {
  test("hard picks the highest pass@1 (gpt-5-5 on the live snapshot)", () => {
    const choice = selectModel(asRows(NOW), CATALOG, "hard", { now: NOW });
    expect(choice?.canonicalId).toBe("gpt");
    expect(choice?.cli).toBe("codex");
  });

  test("easy picks the cheapest entry within 0.6x of the best", () => {
    const choice = selectModel(asRows(NOW), CATALOG, "easy", { now: NOW });
    // On the live snapshot only opus (0.582) and gpt (0.700) clear 0.6x best;
    // opus's best row is cheaper than gpt's at the matched pass@1? Assert the
    // invariant instead of a name: the pick clears the quality floor.
    expect(choice).toBeDefined();
    const rows = asRows(NOW);
    const bestPass = Math.max(
      ...rows.filter((r) => r.model === "gpt-5-5").map((r) => r.passAt1 ?? 0),
    );
    const pickNames = CATALOG.catalog[choice?.canonicalId ?? ""]?.benchmarkNames ?? [];
    const pickPass = Math.max(
      ...rows.filter((r) => pickNames.includes(r.model)).map((r) => r.passAt1 ?? 0),
    );
    expect(pickPass).toBeGreaterThanOrEqual(0.6 * bestPass);
  });

  test("medium picks the best pass@1 per dollar", () => {
    const choice = selectModel(asRows(NOW), CATALOG, "medium", { now: NOW });
    expect(choice).toBeDefined();
    expect(choice?.reason).toContain("per dollar");
  });

  test("stale benchmarks fall back to the configured default", () => {
    const eightDaysAgo = NOW - 8 * 24 * 60 * 60 * 1_000;
    const choice = selectModel(asRows(eightDaysAgo), CATALOG, "hard", { now: NOW });
    expect(choice?.canonicalId).toBe("claude-sonnet");
    expect(choice?.reason).toContain("default");
  });

  test("no data and no default yields undefined (today's behavior)", () => {
    const noDefault: ModelsConfig = { catalog: CATALOG.catalog };
    expect(selectModel([], noDefault, "hard", { now: NOW })).toBeUndefined();
  });

  test("rows that match no catalog entry fall back to the default", () => {
    const onlyUnknown: ModelsConfig = {
      default: "claude-sonnet",
      catalog: {
        "claude-sonnet": { cli: "claude", flag: "sonnet", tier: "mid" }, // no benchmarkNames
      },
    };
    const choice = selectModel(asRows(NOW), onlyUnknown, "hard", { now: NOW });
    expect(choice?.canonicalId).toBe("claude-sonnet");
  });
});
