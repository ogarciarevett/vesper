import { describe, expect, test } from "bun:test";
import { RiskManager } from "../src/risk/RiskManager.js";
import type { Position, RiskConfig, TradeDecision, TradingConfig } from "@repo/types";

const tradingConfig: TradingConfig = {
  pairs: ["ETH"],
  maxLeverage: 5,
  maxPositionSizeUsd: 5000,
  maxConcurrentPositions: 3,
  orderTypes: ["LIMIT", "MARKET"],
};

const riskConfig: RiskConfig = {
  maxDrawdownPct: 10,
  maxDailyLossUsd: 500,
  maxSingleTradeLossUsd: 100,
  stopLossRequired: true,
  forceStopOnDrawdown: true,
};

function baseDecision(overrides: Partial<TradeDecision> = {}): TradeDecision {
  return {
    action: "OPEN_LONG",
    pair: "ETH",
    size: 1,
    leverage: 3,
    orderType: "LIMIT",
    limitPrice: 2000,
    stopLoss: 1950,
    takeProfit: 2100,
    rationale: "test",
    confidence: 80,
    ...overrides,
  };
}

describe("RiskManager", () => {
  test("passes a valid decision", () => {
    const manager = new RiskManager(riskConfig, tradingConfig);
    const result = manager.checkTrade(baseDecision(), [], 0, 10000);
    expect(result.passed).toBeTrue();
    expect(result.reason).toBeUndefined();
  });

  test("rejects decision when leverage exceeds limit", () => {
    const manager = new RiskManager(riskConfig, tradingConfig);
    const result = manager.checkTrade(
      baseDecision({ leverage: 10 }),
      [],
      0,
      10000,
    );

    expect(result.passed).toBeFalse();
    expect(result.reason ?? "").toContain("leverage");
  });

  test("rejects when concurrent positions would exceed max", () => {
    const manager = new RiskManager(riskConfig, {
      ...tradingConfig,
      maxConcurrentPositions: 1,
    });
    const currentPositions: Position[] = [
      {
        pair: "BTC",
        side: "LONG",
        size: 1,
        entryPrice: 40000,
        currentPrice: 40100,
        leverage: 2,
        unrealizedPnl: 10,
        realizedPnl: 0,
        liquidationPrice: 35000,
        marginUsed: 1000,
        openedAt: "2026-02-14T00:00:00.000Z",
      },
    ];

    const result = manager.checkTrade(baseDecision(), currentPositions, 0, 10000);
    expect(result.passed).toBeFalse();
    expect(result.reason ?? "").toContain("concurrentPositions");
  });

  test("triggers force stop when drawdown threshold is breached", () => {
    const manager = new RiskManager(riskConfig, tradingConfig);
    expect(manager.shouldForceStop(-1500, 10000)).toBeTrue();
    expect(manager.shouldForceStop(-200, 10000)).toBeFalse();
  });
});
