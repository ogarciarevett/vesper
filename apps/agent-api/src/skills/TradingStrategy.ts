import type { StrategyType, TradeAction } from "@repo/types";
import type { MarketData, Candle, Position, Signal } from "@repo/types";
import type { HyperliquidClient } from "@repo/hyperliquid-sdk";

/**
 * Enhanced TradingStrategy interface.
 *
 * Strategies receive pre-fetched market data and produce a Signal
 * with a recommended action and confidence level.
 */
export interface TradingStrategy {
  name: string;
  type: StrategyType;
  defaultParams: Record<string, unknown>;

  /** Initialize or reconfigure strategy parameters */
  initialize(params: Record<string, unknown>): void;

  /** Analyze market data and return a trading signal */
  analyze(
    marketData: MarketData,
    candles: Candle[],
    positions: Position[],
  ): Promise<Signal>;

  /** Return current strategy internal state for observability */
  getState(): Record<string, unknown>;
}

/**
 * @deprecated Legacy interface kept for reference only.
 * Use the new TradingStrategy interface above.
 */
export interface LegacyTradingStrategy {
  name: string;
  analyze(client: HyperliquidClient): Promise<LegacyStrategyDecision>;
}

/** @deprecated Use Signal from @repo/types instead */
export interface LegacyStrategyDecision {
  action: "BUY" | "SELL" | "HOLD";
  size?: number;
  price?: number;
  reason: string;
}
