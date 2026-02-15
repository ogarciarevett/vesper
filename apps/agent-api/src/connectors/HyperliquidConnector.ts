/**
 * HyperliquidConnector - Wraps @repo/hyperliquid-sdk to implement
 * the common MarketConnector interface.
 */

import { HyperliquidClient } from "@repo/hyperliquid-sdk";
import type { Candle, Position } from "@repo/types";
import type {
  Balance,
  MarketConnector,
  OrderBook,
  OrderResult,
  PlaceOrderParams,
  Ticker,
} from "./MarketConnector.js";

export class HyperliquidConnector implements MarketConnector {
  readonly name = "hyperliquid";
  readonly exchange = "Hyperliquid";
  private client: HyperliquidClient;

  constructor(client: HyperliquidClient) {
    this.client = client;
  }

  async getTicker(pair: string): Promise<Ticker> {
    const ticker = await this.client.getTicker(pair);
    const book = await this.client.getOrderBook(pair);

    const bestBid = book.levels[0]?.[0]
      ? Number.parseFloat(book.levels[0][0].px)
      : ticker.midPrice;
    const bestAsk = book.levels[1]?.[0]
      ? Number.parseFloat(book.levels[1][0].px)
      : ticker.midPrice;

    return {
      pair,
      bid: bestBid,
      ask: bestAsk,
      midPrice: ticker.midPrice,
      volume24h: 0, // Not directly available from these endpoints
      timestamp: new Date().toISOString(),
    };
  }

  async getOrderBook(pair: string, _depth?: number): Promise<OrderBook> {
    const book = await this.client.getOrderBook(pair);

    const bids: [number, number][] = book.levels[0].map((level) => [
      Number.parseFloat(level.px),
      Number.parseFloat(level.sz),
    ]);
    const asks: [number, number][] = book.levels[1].map((level) => [
      Number.parseFloat(level.px),
      Number.parseFloat(level.sz),
    ]);

    return {
      pair,
      bids,
      asks,
      timestamp: new Date(book.time).toISOString(),
    };
  }

  async getCandles(
    pair: string,
    interval: string,
    limit?: number,
  ): Promise<Candle[]> {
    const now = Date.now();
    const intervalMs = this.intervalToMs(interval);
    const count = limit ?? 100;
    const startTime = now - intervalMs * count;

    const rawCandles = await this.client.getCandles(
      pair,
      interval as Parameters<typeof this.client.getCandles>[1],
      startTime,
      now,
    );

    return rawCandles.map((rc) => ({
      timestamp: new Date(rc.t).toISOString(),
      open: Number.parseFloat(rc.o),
      high: Number.parseFloat(rc.h),
      low: Number.parseFloat(rc.l),
      close: Number.parseFloat(rc.c),
      volume: Number.parseFloat(rc.v),
    }));
  }

  async getBalance(): Promise<Balance> {
    const info = await this.client.getAccountInfo();
    return {
      equity: info.equity,
      totalMarginUsed: info.totalMarginUsed,
      availableMargin: info.equity - info.totalMarginUsed,
      unrealizedPnl: info.positions.reduce((sum, p) => sum + p.unrealizedPnl, 0),
    };
  }

  async getPositions(): Promise<Position[]> {
    const parsed = await this.client.getPositions();
    return parsed.map((p) => ({
      pair: p.coin,
      side: p.side === "long" ? ("LONG" as const) : ("SHORT" as const),
      size: p.size,
      entryPrice: p.entryPrice,
      currentPrice: p.entryPrice + p.unrealizedPnl / p.size, // approximate
      leverage: p.leverage,
      unrealizedPnl: p.unrealizedPnl,
      realizedPnl: 0, // Not available from getPositions
      liquidationPrice: p.liquidationPrice ?? 0,
      marginUsed: p.marginUsed,
      openedAt: new Date().toISOString(), // Not tracked by SDK
    }));
  }

  async placeOrder(params: PlaceOrderParams): Promise<OrderResult> {
    const isBuy = params.side === "BUY";

    if (params.type === "MARKET") {
      // Hyperliquid doesn't have native market orders; use aggressive IOC
      const ticker = await this.client.getTicker(params.pair);
      const slippage = 0.005; // 0.5%
      const price = isBuy
        ? ticker.midPrice * (1 + slippage)
        : ticker.midPrice * (1 - slippage);

      const result = await this.client.placeOrder({
        coin: params.pair,
        isBuy,
        price,
        size: params.size,
        orderType: "market",
        timeInForce: "Ioc",
      });

      return this.parseOrderResult(result);
    }

    const result = await this.client.placeOrder({
      coin: params.pair,
      isBuy,
      price: params.price ?? 0,
      size: params.size,
      orderType: "limit",
      timeInForce: "Gtc",
    });

    return this.parseOrderResult(result);
  }

  async cancelOrder(orderId: string, pair: string): Promise<void> {
    await this.client.cancelOrder({
      coin: pair,
      orderId: Number.parseInt(orderId, 10),
    });
  }

  async getSupportedPairs(): Promise<string[]> {
    const meta = await this.client.getMeta();
    return meta.universe.map((a) => a.name);
  }

  private parseOrderResult(result: {
    status: string;
    response?: { data?: { statuses: Array<{ resting?: { oid: number }; filled?: { totalSz: string; avgPx: string; oid: number }; error?: string }> } };
  }): OrderResult {
    if (result.status !== "ok") {
      return {
        orderId: "",
        status: "REJECTED",
        filledSize: 0,
        avgFillPrice: 0,
        message: "Exchange returned error status",
      };
    }

    const statuses = result.response?.data?.statuses;
    if (!statuses || statuses.length === 0) {
      return {
        orderId: "",
        status: "PLACED",
        filledSize: 0,
        avgFillPrice: 0,
      };
    }

    const first = statuses[0]!;
    if (first.error) {
      return {
        orderId: "",
        status: "REJECTED",
        filledSize: 0,
        avgFillPrice: 0,
        message: first.error,
      };
    }

    if (first.filled) {
      return {
        orderId: String(first.filled.oid),
        status: "FILLED",
        filledSize: Number.parseFloat(first.filled.totalSz),
        avgFillPrice: Number.parseFloat(first.filled.avgPx),
      };
    }

    if (first.resting) {
      return {
        orderId: String(first.resting.oid),
        status: "PLACED",
        filledSize: 0,
        avgFillPrice: 0,
      };
    }

    return {
      orderId: "",
      status: "PLACED",
      filledSize: 0,
      avgFillPrice: 0,
    };
  }

  private intervalToMs(interval: string): number {
    const map: Record<string, number> = {
      "1m": 60_000,
      "3m": 180_000,
      "5m": 300_000,
      "15m": 900_000,
      "30m": 1_800_000,
      "1h": 3_600_000,
      "2h": 7_200_000,
      "4h": 14_400_000,
      "8h": 28_800_000,
      "12h": 43_200_000,
      "1d": 86_400_000,
      "1w": 604_800_000,
    };
    return map[interval] ?? 300_000; // default to 5m
  }
}
