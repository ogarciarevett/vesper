import { HyperliquidClient } from "@repo/hyperliquid-sdk";

export interface MarketState {
  midPrice: number;
  openOrders: any[]; // Using any for now, refine with SDK types
  balance: number;
}

export interface StrategyDecision {
  action: "BUY" | "SELL" | "HOLD";
  size?: number;
  price?: number;
  reason: string;
}

export interface TradingStrategy {
  name: string;
  analyze(client: HyperliquidClient): Promise<StrategyDecision>;
}
