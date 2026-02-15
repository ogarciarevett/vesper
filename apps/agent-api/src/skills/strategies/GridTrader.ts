/**
 * Grid Trader Strategy
 *
 * Places a grid of limit orders above and below current price,
 * profiting from range-bound markets. Adjusts grid based on volatility.
 * Includes funding rate harvesting when aligned.
 *
 * Timeframe: Continuous
 * Entry:     Grid of limit orders around mid price
 * Exit:      Grid rebalance or ATR-based adjustment
 */

import type { Candle, MarketData, Position, Signal, StrategyType } from "@repo/types";
import { calculateATR } from "../indicators/volatility.js";

interface GridTraderParams {
  gridLevels: number;
  gridSpacingPct: number;
  orderSizeUsd: number;
  rebalanceThresholdPct: number;
  useAtrSpacing: boolean;
  atrMultiplier: number;
}

const DEFAULT_PARAMS: GridTraderParams = {
  gridLevels: 5,
  gridSpacingPct: 0.3,
  orderSizeUsd: 50,
  rebalanceThresholdPct: 3.0,
  useAtrSpacing: true,
  atrMultiplier: 0.5,
};

interface GridLevel {
  price: number;
  side: "BUY" | "SELL";
  index: number;
}

export class GridTrader {
  readonly name = "GRID_TRADER";
  readonly type: StrategyType = "GRID_TRADER";
  readonly defaultParams: Record<string, unknown> = { ...DEFAULT_PARAMS };

  private params: GridTraderParams = { ...DEFAULT_PARAMS };
  private gridCenter = 0;
  private currentGrid: GridLevel[] = [];
  private initialized = false;

  initialize(params: Record<string, unknown>): void {
    this.params = {
      ...DEFAULT_PARAMS,
      ...params,
    } as GridTraderParams;
  }

  async analyze(
    marketData: MarketData,
    candles: Candle[],
    positions: Position[],
  ): Promise<Signal> {
    const now = new Date().toISOString();
    const pair = marketData.pair;
    const currentPrice = marketData.price;

    // Calculate ATR for dynamic spacing
    let spacing = currentPrice * (this.params.gridSpacingPct / 100);
    if (this.params.useAtrSpacing && candles.length >= 14) {
      const atr = calculateATR(candles.slice(-14), 14);
      if (atr > 0) {
        spacing = atr * this.params.atrMultiplier;
      }
    }

    // Initialize grid center on first run
    if (!this.initialized || this.gridCenter === 0) {
      this.gridCenter = currentPrice;
      this.currentGrid = this.buildGrid(currentPrice, spacing);
      this.initialized = true;

      return {
        skillName: this.name,
        action: "ADJUST",
        pair,
        confidence: 60,
        metadata: {
          reason: "Initializing grid",
          gridCenter: this.gridCenter,
          gridLevels: this.currentGrid,
          spacing,
          orderSizeUsd: this.params.orderSizeUsd,
        },
        timestamp: now,
      };
    }

    // Check if price has moved beyond rebalance threshold
    const deviationPct =
      Math.abs(currentPrice - this.gridCenter) / this.gridCenter * 100;

    if (deviationPct >= this.params.rebalanceThresholdPct) {
      // Recenter the grid
      this.gridCenter = currentPrice;
      this.currentGrid = this.buildGrid(currentPrice, spacing);

      return {
        skillName: this.name,
        action: "ADJUST",
        pair,
        confidence: 65,
        metadata: {
          reason: "Grid rebalance - price moved beyond threshold",
          gridCenter: this.gridCenter,
          gridLevels: this.currentGrid,
          spacing,
          deviationPct,
          orderSizeUsd: this.params.orderSizeUsd,
        },
        timestamp: now,
      };
    }

    // Check funding rate for harvesting opportunity
    const fundingRate = marketData.fundingRate;
    let fundingNote = "";
    if (Math.abs(fundingRate) > 0.0005) {
      fundingNote = fundingRate > 0
        ? "High positive funding - grid shorts collect funding"
        : "High negative funding - grid longs collect funding";
    }

    // Grid is active and within range -- hold
    return {
      skillName: this.name,
      action: "HOLD",
      pair,
      confidence: 50,
      metadata: {
        reason: "Grid active within range",
        gridCenter: this.gridCenter,
        currentDeviation: deviationPct,
        spacing,
        gridLevels: this.currentGrid.length,
        fundingRate,
        fundingNote,
      },
      timestamp: now,
    };
  }

  getState(): Record<string, unknown> {
    return {
      name: this.name,
      params: this.params,
      gridCenter: this.gridCenter,
      gridLevelCount: this.currentGrid.length,
      currentGrid: this.currentGrid,
      initialized: this.initialized,
    };
  }

  private buildGrid(centerPrice: number, spacing: number): GridLevel[] {
    const grid: GridLevel[] = [];

    // Buy levels below current price
    for (let i = 1; i <= this.params.gridLevels; i++) {
      grid.push({
        price: centerPrice - spacing * i,
        side: "BUY",
        index: -i,
      });
    }

    // Sell levels above current price
    for (let i = 1; i <= this.params.gridLevels; i++) {
      grid.push({
        price: centerPrice + spacing * i,
        side: "SELL",
        index: i,
      });
    }

    return grid;
  }
}
