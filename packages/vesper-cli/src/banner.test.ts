import { describe, expect, test } from "bun:test";
import { VARIANTS, agentFace, faceFromSeed, machineFingerprint } from "./banner.ts";

describe("agent face", () => {
  test("is deterministic for a given seed", () => {
    expect(faceFromSeed("machine-abc")).toEqual(faceFromSeed("machine-abc"));
  });

  test("differs across seeds (id)", () => {
    expect(faceFromSeed("machine-abc").id).not.toBe(faceFromSeed("machine-xyz").id);
  });

  test("renders 5 lines, each exactly 11 columns wide", () => {
    const { lines } = faceFromSeed("seed-1");
    expect(lines).toHaveLength(5);
    for (const l of lines) expect([...l].length).toBe(11);
  });

  test("id is 6 lowercase hex chars", () => {
    expect(faceFromSeed("seed-2").id).toMatch(/^[0-9a-f]{6}$/);
  });

  test("EVERY variant has the exact expected width", () => {
    for (const e of VARIANTS.EYES) expect([...e].length).toBe(9);
    for (const m of VARIANTS.MOUTHS) expect([...m].length).toBe(9);
    for (const a of VARIANTS.ANTENNAE) expect([...a].length).toBe(11);
    for (const [top, bottom, l, r] of VARIANTS.FRAMES) {
      expect([...top].length).toBe(11);
      expect([...bottom].length).toBe(11);
      expect([...l].length).toBe(1);
      expect([...r].length).toBe(1);
    }
  });

  test("offers a large combination space (> 1M)", () => {
    const combos =
      VARIANTS.EYES.length *
      VARIANTS.MOUTHS.length *
      VARIANTS.ANTENNAE.length *
      VARIANTS.FRAMES.length;
    expect(combos).toBeGreaterThan(1_000_000);
  });

  test("500 sampled faces all render 5 lines of width 11", () => {
    for (let i = 0; i < 500; i++) {
      const { lines } = faceFromSeed(`seed-${i}`);
      expect(lines).toHaveLength(5);
      for (const l of lines) expect([...l].length).toBe(11);
    }
  });

  test("machineFingerprint is non-empty and stable within a run", () => {
    const fp = machineFingerprint();
    expect(fp.length).toBeGreaterThan(0);
    expect(machineFingerprint()).toBe(fp);
  });

  test("agentFace matches faceFromSeed(machineFingerprint())", () => {
    expect(agentFace()).toEqual(faceFromSeed(machineFingerprint()));
  });
});
