import { describe, expect, test } from "bun:test";
import {
  calculateEMA,
  calculateRSI,
  calculateVWAP,
  isVolumeExpansion,
} from "../src/skills/indicators/index.js";
import type { Candle } from "@repo/types";

describe("indicators", () => {
  test("calculateRSI returns neutral with insufficient data", () => {
    expect(calculateRSI([100, 101, 102], 14)).toBe(50);
  });

  test("calculateEMA tracks trend and stays bounded", () => {
    const closes = [100, 101, 102, 103, 104, 105, 106, 107, 108];
    const ema = calculateEMA(closes, 5);
    expect(ema).toBeGreaterThan(102);
    expect(ema).toBeLessThanOrEqual(108);
  });

  test("calculateVWAP ignores zero-volume candles", () => {
    const candles: Candle[] = [
      {
        timestamp: "2026-02-14T00:00:00.000Z",
        open: 100,
        high: 101,
        low: 99,
        close: 100,
        volume: 10,
      },
      {
        timestamp: "2026-02-14T00:01:00.000Z",
        open: 110,
        high: 111,
        low: 109,
        close: 110,
        volume: 0,
      },
    ];

    const vwap = calculateVWAP(candles);
    expect(vwap).toBeGreaterThan(99);
    expect(vwap).toBeLessThan(101);
  });

  test("isVolumeExpansion detects last-candle spike", () => {
    const candles: Candle[] = [
      {
        timestamp: "2026-02-14T00:00:00.000Z",
        open: 100,
        high: 101,
        low: 99,
        close: 100,
        volume: 100,
      },
      {
        timestamp: "2026-02-14T00:01:00.000Z",
        open: 100,
        high: 102,
        low: 99,
        close: 101,
        volume: 110,
      },
      {
        timestamp: "2026-02-14T00:02:00.000Z",
        open: 101,
        high: 103,
        low: 100,
        close: 102,
        volume: 400,
      },
    ];

    expect(isVolumeExpansion(candles, 2)).toBeTrue();
  });
});
