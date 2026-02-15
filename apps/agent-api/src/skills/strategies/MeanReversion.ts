/**
 * Mean Reversion Strategy
 *
 * Detects overbought/oversold conditions using Bollinger Bands and RSI,
 * entering positions against the extreme with the expectation of mean reversion.
 * Considers funding rate for directional bias.
 *
 * Timeframe: 5m-1h candles
 * Entry:     Price at Bollinger Band extreme + RSI confirmation
 * Exit:      Mean (middle band) or opposite extreme
 */

import type { Candle, MarketData, Position, Signal, StrategyType } from "@repo/types";
import { calculateRSI } from "../indicators/momentum.js";
import { calculateBollingerBands } from "../indicators/volatility.js";

interface MeanReversionParams {
  bollingerPeriod: number;
  bollingerStdDev: number;
  rsiPeriod: number;
  rsiOverbought: number;
  rsiOversold: number;
  maxHoldPeriod: number;
  fundingBiasWeight: number;
}

const DEFAULT_PARAMS: MeanReversionParams = {
  bollingerPeriod: 20,
  bollingerStdDev: 2.0,
  rsiPeriod: 14,
  rsiOverbought: 70,
  rsiOversold: 30,
  maxHoldPeriod: 60,
  fundingBiasWeight: 0.15,
};

export class MeanReversion {
  readonly name = "MEAN_REVERSION";
  readonly type: StrategyType = "MEAN_REVERSION";
  readonly defaultParams: Record<string, unknown> = { ...DEFAULT_PARAMS };

  private params: MeanReversionParams = { ...DEFAULT_PARAMS };
  private ticksInPosition = 0;

  initialize(params: Record<string, unknown>): void {
    this.params = {
      ...DEFAULT_PARAMS,
      ...params,
    } as MeanReversionParams;
  }

  async analyze(
    marketData: MarketData,
    candles: Candle[],
    positions: Position[],
  ): Promise<Signal> {
    const now = new Date().toISOString();
    const pair = marketData.pair;

    if (candles.length < this.params.bollingerPeriod + 5) {
      return this.holdSignal(pair, now, "Insufficient candle data");
    }

    const closes = candles.map((c) => c.close);
    const currentPrice = marketData.price;

    // Calculate indicators
    const bb = calculateBollingerBands(
      closes,
      this.params.bollingerPeriod,
      this.params.bollingerStdDev,
    );
    const rsi = calculateRSI(closes, this.params.rsiPeriod);

    // Measure how far price is from the bands (normalized)
    const bandWidth = bb.upper - bb.lower;
    const pricePosition = bandWidth > 0
      ? (currentPrice - bb.lower) / bandWidth
      : 0.5;

    // Funding rate bias: positive funding = short bias, negative = long bias
    const fundingRate = marketData.fundingRate;
    let fundingBias = 0;
    if (Math.abs(fundingRate) > 0.0001) {
      // Positive funding -> longs pay shorts -> short bias (more likely to revert down)
      // Negative funding -> shorts pay longs -> long bias (more likely to revert up)
      fundingBias = -Math.sign(fundingRate) * this.params.fundingBiasWeight;
    }

    // Check for existing position -- handle exit
    const openPosition = positions.find((p) => p.pair === pair);
    if (openPosition) {
      this.ticksInPosition++;

      // Exit if price has reverted to mean
      const atMean =
        (openPosition.side === "LONG" && currentPrice >= bb.middle) ||
        (openPosition.side === "SHORT" && currentPrice <= bb.middle);

      if (atMean || this.ticksInPosition >= this.params.maxHoldPeriod) {
        this.ticksInPosition = 0;
        return {
          skillName: this.name,
          action: "CLOSE",
          pair,
          confidence: 75,
          metadata: {
            reason: atMean ? "Price reverted to mean" : "Max hold period reached",
            rsi,
            bollinger: bb,
            pricePosition,
            ticksHeld: this.ticksInPosition,
          },
          timestamp: now,
        };
      }

      return this.holdSignal(pair, now, "Waiting for mean reversion", {
        rsi,
        bollinger: bb,
        pricePosition,
        ticksHeld: this.ticksInPosition,
      });
    }

    this.ticksInPosition = 0;

    const metadata: Record<string, unknown> = {
      rsi,
      bollinger: bb,
      pricePosition,
      fundingRate,
      fundingBias,
      currentPrice,
    };

    // LONG signal: price at/below lower band + RSI oversold
    if (currentPrice <= bb.lower && rsi < this.params.rsiOversold) {
      // How extreme is the deviation?
      const deviation = (bb.lower - currentPrice) / (bandWidth || 1);
      let confidence = 50 + Math.min(deviation * 100, 30) + (this.params.rsiOversold - rsi);
      confidence += fundingBias * 100; // funding bonus for long bias
      confidence = Math.min(Math.max(Math.round(confidence), 30), 95);

      return {
        skillName: this.name,
        action: "OPEN_LONG",
        pair,
        confidence,
        metadata: { ...metadata, deviation, targetPrice: bb.middle },
        timestamp: now,
      };
    }

    // SHORT signal: price at/above upper band + RSI overbought
    if (currentPrice >= bb.upper && rsi > this.params.rsiOverbought) {
      const deviation = (currentPrice - bb.upper) / (bandWidth || 1);
      let confidence = 50 + Math.min(deviation * 100, 30) + (rsi - this.params.rsiOverbought);
      confidence -= fundingBias * 100; // funding bonus for short bias
      confidence = Math.min(Math.max(Math.round(confidence), 30), 95);

      return {
        skillName: this.name,
        action: "OPEN_SHORT",
        pair,
        confidence,
        metadata: { ...metadata, deviation, targetPrice: bb.middle },
        timestamp: now,
      };
    }

    return this.holdSignal(pair, now, "No extreme conditions detected", metadata);
  }

  getState(): Record<string, unknown> {
    return {
      name: this.name,
      params: this.params,
      ticksInPosition: this.ticksInPosition,
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
