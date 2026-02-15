/**
 * Breakout Hunter Strategy
 *
 * Monitors key support/resistance levels and enters on confirmed breakouts
 * with volume expansion. Uses ATR for trailing stops and order book depth
 * to filter false breakouts.
 *
 * Timeframe: 15m-4h candles
 * Entry:     Price breaks key level with volume confirmation
 * Exit:      ATR-based trailing stop
 */

import type { Candle, MarketData, Position, Signal, StrategyType } from "@repo/types";
import { detectSupportResistance } from "../indicators/trend.js";
import { calculateATR } from "../indicators/volatility.js";
import { isVolumeExpansion } from "../indicators/volume.js";

interface BreakoutHunterParams {
  lookbackPeriod: number;
  breakoutConfirmCandles: number;
  volumeBreakoutMultiplier: number;
  falseBreakoutFilter: boolean;
  atrMultiplierStop: number;
  minLevelTouches: number;
}

const DEFAULT_PARAMS: BreakoutHunterParams = {
  lookbackPeriod: 100,
  breakoutConfirmCandles: 3,
  volumeBreakoutMultiplier: 2.0,
  falseBreakoutFilter: true,
  atrMultiplierStop: 2.0,
  minLevelTouches: 2,
};

export class BreakoutHunter {
  readonly name = "BREAKOUT_HUNTER";
  readonly type: StrategyType = "BREAKOUT_HUNTER";
  readonly defaultParams: Record<string, unknown> = { ...DEFAULT_PARAMS };

  private params: BreakoutHunterParams = { ...DEFAULT_PARAMS };
  private confirmedLevels: { supports: number[]; resistances: number[] } = {
    supports: [],
    resistances: [],
  };
  private breakoutConfirmCount = 0;
  private pendingBreakoutDirection: "LONG" | "SHORT" | null = null;
  private pendingBreakoutLevel = 0;

  initialize(params: Record<string, unknown>): void {
    this.params = {
      ...DEFAULT_PARAMS,
      ...params,
    } as BreakoutHunterParams;
  }

  async analyze(
    marketData: MarketData,
    candles: Candle[],
    positions: Position[],
  ): Promise<Signal> {
    const now = new Date().toISOString();
    const pair = marketData.pair;

    if (candles.length < Math.max(this.params.lookbackPeriod, 20)) {
      return this.holdSignal(pair, now, "Insufficient candle data");
    }

    const currentPrice = marketData.price;
    const atr = calculateATR(candles.slice(-14), 14);

    // Detect S/R levels
    const levels = detectSupportResistance(candles, this.params.lookbackPeriod);
    this.confirmedLevels = this.clusterLevels(levels, atr);

    // Check for existing position
    const openPosition = positions.find((p) => p.pair === pair);
    if (openPosition) {
      return this.holdSignal(pair, now, "Position open, monitoring via trailing stop", {
        atr,
        levels: this.confirmedLevels,
      });
    }

    // Check for volume expansion
    const volumeConfirmed = isVolumeExpansion(candles, this.params.volumeBreakoutMultiplier);

    // Find the nearest resistance above and support below
    const nearestResistance = this.findNearestAbove(
      this.confirmedLevels.resistances,
      currentPrice,
    );
    const nearestSupport = this.findNearestBelow(
      this.confirmedLevels.supports,
      currentPrice,
    );

    const metadata: Record<string, unknown> = {
      atr,
      supports: this.confirmedLevels.supports,
      resistances: this.confirmedLevels.resistances,
      nearestResistance,
      nearestSupport,
      volumeConfirmed,
      currentPrice,
      pendingBreakoutDirection: this.pendingBreakoutDirection,
      breakoutConfirmCount: this.breakoutConfirmCount,
    };

    // Check resistance breakout (LONG)
    if (nearestResistance !== null) {
      const breakingAbove = currentPrice > nearestResistance;

      if (breakingAbove) {
        if (
          this.pendingBreakoutDirection === "LONG" &&
          Math.abs(this.pendingBreakoutLevel - nearestResistance) < atr * 0.5
        ) {
          this.breakoutConfirmCount++;
        } else {
          this.pendingBreakoutDirection = "LONG";
          this.pendingBreakoutLevel = nearestResistance;
          this.breakoutConfirmCount = 1;
        }

        if (this.breakoutConfirmCount >= this.params.breakoutConfirmCandles) {
          // False breakout filter: check order book depth
          if (this.params.falseBreakoutFilter) {
            const askDepth = this.estimateOrderBookDepth(marketData, "asks");
            const bidDepth = this.estimateOrderBookDepth(marketData, "bids");
            // Thin asks above resistance = genuine breakout
            if (askDepth > bidDepth * 2) {
              this.resetPending();
              return this.holdSignal(pair, now, "False breakout filtered (heavy asks)", metadata);
            }
          }

          if (!volumeConfirmed) {
            return this.holdSignal(pair, now, "Breakout lacks volume confirmation", metadata);
          }

          this.resetPending();
          const stopLoss = currentPrice - atr * this.params.atrMultiplierStop;
          const confidence = Math.min(
            60 + this.breakoutConfirmCount * 5 + (volumeConfirmed ? 15 : 0),
            90,
          );

          return {
            skillName: this.name,
            action: "OPEN_LONG",
            pair,
            confidence,
            metadata: {
              ...metadata,
              breakoutLevel: nearestResistance,
              suggestedStopLoss: stopLoss,
              atrStop: atr * this.params.atrMultiplierStop,
            },
            timestamp: now,
          };
        }
      }
    }

    // Check support breakdown (SHORT)
    if (nearestSupport !== null) {
      const breakingBelow = currentPrice < nearestSupport;

      if (breakingBelow) {
        if (
          this.pendingBreakoutDirection === "SHORT" &&
          Math.abs(this.pendingBreakoutLevel - nearestSupport) < atr * 0.5
        ) {
          this.breakoutConfirmCount++;
        } else {
          this.pendingBreakoutDirection = "SHORT";
          this.pendingBreakoutLevel = nearestSupport;
          this.breakoutConfirmCount = 1;
        }

        if (this.breakoutConfirmCount >= this.params.breakoutConfirmCandles) {
          if (this.params.falseBreakoutFilter) {
            const askDepth = this.estimateOrderBookDepth(marketData, "asks");
            const bidDepth = this.estimateOrderBookDepth(marketData, "bids");
            if (bidDepth > askDepth * 2) {
              this.resetPending();
              return this.holdSignal(pair, now, "False breakdown filtered (heavy bids)", metadata);
            }
          }

          if (!volumeConfirmed) {
            return this.holdSignal(pair, now, "Breakdown lacks volume confirmation", metadata);
          }

          this.resetPending();
          const stopLoss = currentPrice + atr * this.params.atrMultiplierStop;
          const confidence = Math.min(
            60 + this.breakoutConfirmCount * 5 + (volumeConfirmed ? 15 : 0),
            90,
          );

          return {
            skillName: this.name,
            action: "OPEN_SHORT",
            pair,
            confidence,
            metadata: {
              ...metadata,
              breakoutLevel: nearestSupport,
              suggestedStopLoss: stopLoss,
              atrStop: atr * this.params.atrMultiplierStop,
            },
            timestamp: now,
          };
        }
      }
    }

    // No breakout detected, reset if price came back inside range
    if (
      this.pendingBreakoutDirection &&
      nearestResistance !== null &&
      nearestSupport !== null &&
      currentPrice > (nearestSupport ?? 0) &&
      currentPrice < (nearestResistance ?? Number.POSITIVE_INFINITY)
    ) {
      this.resetPending();
    }

    return this.holdSignal(pair, now, "No breakout detected", metadata);
  }

  getState(): Record<string, unknown> {
    return {
      name: this.name,
      params: this.params,
      confirmedLevels: this.confirmedLevels,
      pendingBreakoutDirection: this.pendingBreakoutDirection,
      pendingBreakoutLevel: this.pendingBreakoutLevel,
      breakoutConfirmCount: this.breakoutConfirmCount,
    };
  }

  /**
   * Cluster nearby levels together to avoid duplicate S/R.
   * Levels within `atr * 0.3` of each other are merged.
   */
  private clusterLevels(
    levels: { supports: number[]; resistances: number[] },
    atr: number,
  ): { supports: number[]; resistances: number[] } {
    const threshold = atr * 0.3;
    return {
      supports: this.mergeLevels(levels.supports, threshold),
      resistances: this.mergeLevels(levels.resistances, threshold),
    };
  }

  private mergeLevels(levels: number[], threshold: number): number[] {
    if (levels.length === 0) return [];

    const sorted = [...levels].sort((a, b) => a - b);
    const merged: number[] = [];
    let cluster: number[] = [sorted[0]!];

    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i]! - sorted[i - 1]! <= threshold) {
        cluster.push(sorted[i]!);
      } else {
        // Average the cluster
        merged.push(cluster.reduce((s, v) => s + v, 0) / cluster.length);
        cluster = [sorted[i]!];
      }
    }
    merged.push(cluster.reduce((s, v) => s + v, 0) / cluster.length);

    return merged;
  }

  private findNearestAbove(levels: number[], price: number): number | null {
    let nearest: number | null = null;
    for (const level of levels) {
      if (level > price * 0.99) {
        // Allow 1% tolerance
        if (nearest === null || level < nearest) {
          nearest = level;
        }
      }
    }
    return nearest;
  }

  private findNearestBelow(levels: number[], price: number): number | null {
    let nearest: number | null = null;
    for (const level of levels) {
      if (level < price * 1.01) {
        if (nearest === null || level > nearest) {
          nearest = level;
        }
      }
    }
    return nearest;
  }

  private estimateOrderBookDepth(
    marketData: MarketData,
    side: "bids" | "asks",
  ): number {
    const levels = marketData.orderBook[side];
    let totalSize = 0;
    for (const [, size] of levels.slice(0, 5)) {
      totalSize += size;
    }
    return totalSize;
  }

  private resetPending(): void {
    this.pendingBreakoutDirection = null;
    this.pendingBreakoutLevel = 0;
    this.breakoutConfirmCount = 0;
  }

  private holdSignal(
    pair: string,
    timestamp: string,
    reason: string,
    metadata: Record<string, unknown> = {},
  ): Signal {
    return {
      skillName: this.name,
      action: "HOLD",
      pair,
      confidence: 0,
      metadata: { reason, ...metadata },
      timestamp,
    };
  }
}
