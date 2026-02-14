import { describe, expect, test } from "bun:test";
import { createStrategy } from "../src/skills/strategies/index.js";
import type { Candle, MarketData } from "@repo/types";

const sampleMarket: MarketData = {
  pair: "ETH",
  timestamp: "2026-02-14T00:00:00.000Z",
  price: 2500,
  bid: 2499,
  ask: 2501,
  volume24h: 1000000,
  change24hPct: 1.2,
  fundingRate: 0.01,
  openInterest: 500000,
  orderBook: {
    bids: [
      [2499, 10],
      [2498, 8],
    ],
    asks: [
      [2501, 10],
      [2502, 8],
    ],
    timestamp: "2026-02-14T00:00:00.000Z",
  },
};

const shortCandles: Candle[] = [
  {
    timestamp: "2026-02-14T00:00:00.000Z",
    open: 2490,
    high: 2505,
    low: 2485,
    close: 2500,
    volume: 1000,
  },
];

describe("strategy registry", () => {
  test("creates known strategies by type", () => {
    expect(createStrategy("MOMENTUM_SCALPER").name).toBe("MOMENTUM_SCALPER");
    expect(createStrategy("MEAN_REVERSION").name).toBe("MEAN_REVERSION");
    expect(createStrategy("BREAKOUT_HUNTER").name).toBe("BREAKOUT_HUNTER");
    expect(createStrategy("GRID_TRADER").name).toBe("GRID_TRADER");
    expect(createStrategy("FUNDING_RATE_ARB").name).toBe("FUNDING_RATE_ARB");
  });

  test("returns HOLD when momentum strategy lacks candles", async () => {
    const strategy = createStrategy("MOMENTUM_SCALPER");
    const signal = await strategy.analyze(sampleMarket, shortCandles, []);
    expect(signal.action).toBe("HOLD");
    expect(signal.metadata.reason).toBe("Insufficient candle data");
  });
});
