/**
 * Momentum Scalper Strategy
 *
 * Identifies short-term momentum bursts and scalps quick entries on PERPS
 * with tight stop-losses. Uses RSI, MACD, ROC, and volume confirmation.
 *
 * Timeframe: 1m-15m candles
 * Entry:     Strong momentum confirmed by volume expansion
 * Exit:      Tight stop-loss (0.25%), quick take-profit (0.5%)
 * Leverage:  2x-5x configurable
 */

import type { Candle, MarketData, Position, Signal, StrategyType } from "@repo/types";
import { calculateRSI, calculateMACD, calculateROC } from "../indicators/momentum.js";
import { isVolumeExpansion } from "../indicators/volume.js";
import { calculateEMA } from "../indicators/trend.js";

interface MomentumScalperParams {
  lookbackPeriod: number;
  momentumThreshold: number;
  volumeMultiplier: number;
  takeProfitPct: number;
  stopLossPct: number;
  rsiOverbought: number;
  rsiOversold: number;
}

const DEFAULT_PARAMS: MomentumScalperParams = {
  lookbackPeriod: 20,
  momentumThreshold: 0.7,
  volumeMultiplier: 1.5,
  takeProfitPct: 0.5,
  stopLossPct: 0.25,
  rsiOverbought: 70,
  rsiOversold: 30,
};

export class MomentumScalper {
  readonly name = "MOMENTUM_SCALPER";
  readonly type: StrategyType = "MOMENTUM_SCALPER";
  readonly defaultParams: Record<string, unknown> = { ...DEFAULT_PARAMS };

  private params: MomentumScalperParams = { ...DEFAULT_PARAMS };
  private lastSignalTime = 0;

  initialize(params: Record<string, unknown>): void {
    this.params = {
      ...DEFAULT_PARAMS,
      ...params,
    } as MomentumScalperParams;
  }

  async analyze(
    marketData: MarketData,
    candles: Candle[],
    positions: Position[],
  ): Promise<Signal> {
    const now = new Date().toISOString();
    const pair = marketData.pair;

    // Need enough candles for indicator calculation
    if (candles.length < this.params.lookbackPeriod + 10) {
      return this.holdSignal(pair, now, "Insufficient candle data");
    }

    const closes = candles.map((c) => c.close);

    // Calculate indicators
    const rsi = calculateRSI(closes, 14);
    const macd = calculateMACD(closes, 12, 26, 9);
    const roc = calculateROC(closes, this.params.lookbackPeriod);
    const volumeExpanding = isVolumeExpansion(candles, this.params.volumeMultiplier);
    const emaFast = calculateEMA(closes, 9);
    const emaSlow = calculateEMA(closes, 21);

    // If we have an open position on this pair, check for exit
    const openPosition = positions.find((p) => p.pair === pair);
    if (openPosition) {
      return this.holdSignal(pair, now, "Position already open, monitoring via SL/TP");
    }

    // Score momentum direction
    let bullScore = 0;
    let bearScore = 0;

    // RSI momentum
    if (rsi > 50 && rsi < this.params.rsiOverbought) bullScore += 0.2;
    if (rsi < 50 && rsi > this.params.rsiOversold) bearScore += 0.2;

    // MACD direction
    if (macd.histogram > 0 && macd.macd > macd.signal) bullScore += 0.25;
    if (macd.histogram < 0 && macd.macd < macd.signal) bearScore += 0.25;

    // ROC momentum
    const absRoc = Math.abs(roc);
    if (roc > 0 && absRoc > 0.1) bullScore += Math.min(absRoc / 2, 0.25);
    if (roc < 0 && absRoc > 0.1) bearScore += Math.min(absRoc / 2, 0.25);

    // EMA trend alignment
    if (emaFast > emaSlow) bullScore += 0.15;
    if (emaFast < emaSlow) bearScore += 0.15;

    // Volume confirmation is required
    if (!volumeExpanding) {
      bullScore *= 0.5;
      bearScore *= 0.5;
    } else {
      bullScore += 0.15;
      bearScore += 0.15;
    }

    const metadata: Record<string, unknown> = {
      rsi,
      macd,
      roc,
      volumeExpanding,
      emaFast,
      emaSlow,
      bullScore,
      bearScore,
      stopLossPct: this.params.stopLossPct,
      takeProfitPct: this.params.takeProfitPct,
    };

    // Signal generation
    if (bullScore >= this.params.momentumThreshold && bullScore > bearScore) {
      const confidence = Math.min(Math.round(bullScore * 100), 95);
      return {
        skillName: this.name,
        action: "OPEN_LONG",
        pair,
        confidence,
        metadata,
        timestamp: now,
      };
    }

    if (bearScore >= this.params.momentumThreshold && bearScore > bullScore) {
      const confidence = Math.min(Math.round(bearScore * 100), 95);
      return {
        skillName: this.name,
        action: "OPEN_SHORT",
        pair,
        confidence,
        metadata,
        timestamp: now,
      };
    }

    return this.holdSignal(pair, now, "Momentum below threshold", metadata);
  }

  getState(): Record<string, unknown> {
    return {
      name: this.name,
      params: this.params,
      lastSignalTime: this.lastSignalTime,
    };
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
