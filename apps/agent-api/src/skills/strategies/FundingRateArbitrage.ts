/**
 * Funding Rate Arbitrage Strategy
 *
 * Exploits extreme funding rates by taking positions opposite to the
 * funding direction, collecting funding payments while hedging directional risk.
 *
 * Timeframe: 8h+ (aligned with funding periods)
 * Entry:     When predicted funding rate exceeds threshold
 * Direction: Opposite to funding direction (collect funding)
 * Hold time: Minimum 8 hours to capture one funding payment
 */

import type { Candle, MarketData, Position, Signal, StrategyType } from "@repo/types";

interface FundingRateArbParams {
  fundingThresholdPct: number;
  minHoldHours: number;
  maxPositionPct: number;
  hedgeEnabled: boolean;
  fundingStabilityLookback: number;
}

const DEFAULT_PARAMS: FundingRateArbParams = {
  fundingThresholdPct: 0.01,
  minHoldHours: 8,
  maxPositionPct: 10,
  hedgeEnabled: false,
  fundingStabilityLookback: 3,
};

export class FundingRateArbitrage {
  readonly name = "FUNDING_RATE_ARB";
  readonly type: StrategyType = "MOMENTUM_SCALPER"; // No FUNDING_RATE_ARB in StrategyType; use closest match
  readonly defaultParams: Record<string, unknown> = { ...DEFAULT_PARAMS };

  private params: FundingRateArbParams = { ...DEFAULT_PARAMS };
  private entryTime: number | null = null;
  private recentFundingRates: number[] = [];

  initialize(params: Record<string, unknown>): void {
    this.params = {
      ...DEFAULT_PARAMS,
      ...params,
    } as FundingRateArbParams;
  }

  async analyze(
    marketData: MarketData,
    candles: Candle[],
    positions: Position[],
  ): Promise<Signal> {
    const now = new Date().toISOString();
    const pair = marketData.pair;
    const fundingRate = marketData.fundingRate;

    // Track funding rate history for stability analysis
    this.recentFundingRates.push(fundingRate);
    if (this.recentFundingRates.length > this.params.fundingStabilityLookback * 10) {
      this.recentFundingRates = this.recentFundingRates.slice(-this.params.fundingStabilityLookback * 10);
    }

    const fundingRatePct = fundingRate * 100;
    const absFundingPct = Math.abs(fundingRatePct);

    // Check for existing position
    const openPosition = positions.find((p) => p.pair === pair);

    if (openPosition) {
      // Check if we've held long enough to capture funding
      if (this.entryTime !== null) {
        const hoursHeld = (Date.now() - this.entryTime) / (1000 * 60 * 60);

        // Check if funding rate has flipped against us
        const fundingFlipped =
          (openPosition.side === "SHORT" && fundingRate < 0) ||
          (openPosition.side === "LONG" && fundingRate > 0);

        if (hoursHeld >= this.params.minHoldHours) {
          // We've captured at least one funding period
          if (fundingFlipped || absFundingPct < this.params.fundingThresholdPct / 2) {
            this.entryTime = null;
            return {
              skillName: this.name,
              action: "CLOSE",
              pair,
              confidence: 70,
              metadata: {
                reason: fundingFlipped
                  ? "Funding rate flipped - closing position"
                  : "Funding rate normalized - closing position",
                hoursHeld,
                currentFundingPct: fundingRatePct,
                positionSide: openPosition.side,
              },
              timestamp: now,
            };
          }

          // Keep holding -- still collecting
          return this.holdSignal(pair, now, "Holding to collect funding", {
            hoursHeld,
            currentFundingPct: fundingRatePct,
            positionSide: openPosition.side,
          });
        }

        return this.holdSignal(pair, now, "Holding - min hold period not reached", {
          hoursHeld,
          minHoldHours: this.params.minHoldHours,
          currentFundingPct: fundingRatePct,
        });
      }

      // Position exists but no entry time tracked (likely from before strategy started)
      return this.holdSignal(pair, now, "Monitoring existing position");
    }

    // No open position -- evaluate entry
    this.entryTime = null;

    // Check if funding rate exceeds threshold
    if (absFundingPct < this.params.fundingThresholdPct) {
      return this.holdSignal(pair, now, "Funding rate below threshold", {
        fundingRatePct,
        threshold: this.params.fundingThresholdPct,
      });
    }

    // Check funding rate stability
    const isStable = this.isFundingStable(fundingRate);

    const metadata: Record<string, unknown> = {
      fundingRatePct,
      absFundingPct,
      isStable,
      threshold: this.params.fundingThresholdPct,
      hedgeEnabled: this.params.hedgeEnabled,
    };

    if (!isStable) {
      return this.holdSignal(pair, now, "Funding rate unstable - waiting for consistency", metadata);
    }

    // Calculate confidence based on funding magnitude and stability
    const magnitudeBonus = Math.min((absFundingPct / this.params.fundingThresholdPct - 1) * 20, 30);
    const confidence = Math.min(Math.round(55 + magnitudeBonus + (isStable ? 10 : 0)), 90);

    // Positive funding = longs pay shorts -> go SHORT to collect
    // Negative funding = shorts pay longs -> go LONG to collect
    if (fundingRate > 0) {
      this.entryTime = Date.now();
      return {
        skillName: this.name,
        action: "OPEN_SHORT",
        pair,
        confidence,
        metadata: {
          ...metadata,
          reason: "Positive funding rate - shorting to collect funding payments",
          estimatedFundingIncome: `${fundingRatePct.toFixed(4)}% per 8h`,
        },
        timestamp: now,
      };
    }

    this.entryTime = Date.now();
    return {
      skillName: this.name,
      action: "OPEN_LONG",
      pair,
      confidence,
      metadata: {
        ...metadata,
        reason: "Negative funding rate - longing to collect funding payments",
        estimatedFundingIncome: `${absFundingPct.toFixed(4)}% per 8h`,
      },
      timestamp: now,
    };
  }

  getState(): Record<string, unknown> {
    return {
      name: this.name,
      params: this.params,
      entryTime: this.entryTime,
      recentFundingCount: this.recentFundingRates.length,
    };
  }

  /**
   * Check whether funding rate has been consistently in the same direction
   * over recent observations.
   */
  private isFundingStable(currentRate: number): boolean {
    if (this.recentFundingRates.length < this.params.fundingStabilityLookback) {
      return false;
    }

    const recent = this.recentFundingRates.slice(-this.params.fundingStabilityLookback);
    const direction = Math.sign(currentRate);

    // All recent rates must be in the same direction
    for (const rate of recent) {
      if (Math.sign(rate) !== direction) {
        return false;
      }
    }

    return true;
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
