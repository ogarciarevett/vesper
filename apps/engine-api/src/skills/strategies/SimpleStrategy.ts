import type { HyperliquidClient } from "@repo/hyperliquid-sdk";
import type { StrategyDecision, TradingStrategy } from "../TradingStrategy";

export class SimpleStrategy implements TradingStrategy {
  name = "SimpleMarketWatcher";

  async analyze(client: HyperliquidClient): Promise<StrategyDecision> {
    // 1. Get Price
    // const ticker = await client.getTicker("ETH"); // Use ETH for now
    // const price = ticker.midPrice;
    const price = 2000; // Mock for now until SDK types align

    // 2. Logic
    if (Math.random() > 0.8) {
        return {
            action: "BUY",
            reason: `Price ${price} looks good (Random)`,
            price: price * 0.99
        };
    }

    return {
        action: "HOLD",
        reason: "Waiting for signal"
    };
  }
}
