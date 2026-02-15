import type { StrategyType } from "@repo/types";
import type { MarketData, Candle, Position, Signal } from "@repo/types";
import type { TradingStrategy } from "../TradingStrategy";

/**
 * SimpleStrategy is a placeholder/demo strategy that generates
 * random BUY/HOLD signals. It exists to validate the pipeline
 * and will be replaced by real strategies.
 */
export class SimpleStrategy implements TradingStrategy {
  name = "SimpleMarketWatcher";
  type: StrategyType = "MOMENTUM_SCALPER";
  defaultParams: Record<string, unknown> = {
    buyProbability: 0.2,
  };

  private params: Record<string, unknown>;

  constructor() {
    this.params = { ...this.defaultParams };
  }

  initialize(params: Record<string, unknown>): void {
    this.params = { ...this.defaultParams, ...params };
  }

  async analyze(
    marketData: MarketData,
    _candles: Candle[],
    _positions: Position[],
  ): Promise<Signal> {
    const buyProbability = (this.params.buyProbability as number) ?? 0.2;

    if (Math.random() > 1 - buyProbability) {
      return {
        skillName: this.name,
        action: "OPEN_LONG",
        pair: marketData.pair,
        confidence: 30 + Math.floor(Math.random() * 30), // 30-60, low confidence for random
        metadata: {
          reason: `Price ${marketData.price} looks good (Random)`,
          price: marketData.price,
        },
        timestamp: new Date().toISOString(),
      };
    }

    return {
      skillName: this.name,
      action: "HOLD",
      pair: marketData.pair,
      confidence: 10,
      metadata: {
        reason: "Waiting for signal",
      },
      timestamp: new Date().toISOString(),
    };
  }

  getState(): Record<string, unknown> {
    return { ...this.params };
  }
}
