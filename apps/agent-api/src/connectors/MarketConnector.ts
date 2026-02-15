/**
 * MarketConnector - Common interface for exchange connectivity.
 *
 * All connectors (Hyperliquid, CCXT/Binance, etc.) implement this interface
 * so strategies and the price aggregator can work exchange-agnostically.
 */

import type { Candle, Position } from "@repo/types";

export interface Ticker {
  pair: string;
  bid: number;
  ask: number;
  midPrice: number;
  volume24h: number;
  timestamp: string;
}

export interface OrderBook {
  pair: string;
  bids: [number, number][]; // [price, size]
  asks: [number, number][]; // [price, size]
  timestamp: string;
}

export interface Balance {
  equity: number;
  totalMarginUsed: number;
  availableMargin: number;
  unrealizedPnl: number;
}

export interface PlaceOrderParams {
  pair: string;
  side: "BUY" | "SELL";
  type: "LIMIT" | "MARKET";
  size: number;
  price?: number;
  reduceOnly?: boolean;
  stopLoss?: number;
  takeProfit?: number;
}

export interface OrderResult {
  orderId: string;
  status: "PLACED" | "FILLED" | "PARTIALLY_FILLED" | "REJECTED";
  filledSize: number;
  avgFillPrice: number;
  message?: string;
}

export interface MarketConnector {
  name: string;
  exchange: string;

  getTicker(pair: string): Promise<Ticker>;
  getOrderBook(pair: string, depth?: number): Promise<OrderBook>;
  getCandles(pair: string, interval: string, limit?: number): Promise<Candle[]>;
  getBalance(): Promise<Balance>;
  getPositions(): Promise<Position[]>;
  placeOrder(params: PlaceOrderParams): Promise<OrderResult>;
  cancelOrder(orderId: string, pair: string): Promise<void>;
  getSupportedPairs(): Promise<string[]>;
}
