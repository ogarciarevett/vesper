/**
 * CCXTConnector - Lightweight REST-based adapter for Binance Futures.
 *
 * Uses native fetch() only (no ccxt npm package) for CF Workers compatibility.
 * Signs requests with HMAC-SHA256 for authenticated endpoints.
 */

import type { Candle, Position } from "@repo/types";
import type {
  Balance,
  MarketConnector,
  OrderBook,
  OrderResult,
  PlaceOrderParams,
  Ticker,
} from "./MarketConnector.js";

interface BinanceConfig {
  apiKey: string;
  apiSecret: string;
  testnet?: boolean;
}

export class CCXTConnector implements MarketConnector {
  readonly name = "binance-futures";
  readonly exchange = "Binance";

  private apiKey: string;
  private apiSecret: string;
  private baseUrl: string;

  constructor(config: BinanceConfig) {
    this.apiKey = config.apiKey;
    this.apiSecret = config.apiSecret;
    this.baseUrl = config.testnet
      ? "https://testnet.binancefuture.com"
      : "https://fapi.binance.com";
  }

  async getTicker(pair: string): Promise<Ticker> {
    const symbol = this.toSymbol(pair);
    const data = await this.publicGet<{
      symbol: string;
      bidPrice: string;
      askPrice: string;
      volume: string;
      lastPrice: string;
    }>("/fapi/v1/ticker/bookTicker", { symbol });

    const bid = Number.parseFloat(data.bidPrice);
    const ask = Number.parseFloat(data.askPrice);

    return {
      pair,
      bid,
      ask,
      midPrice: (bid + ask) / 2,
      volume24h: Number.parseFloat(data.volume || "0"),
      timestamp: new Date().toISOString(),
    };
  }

  async getOrderBook(pair: string, depth = 20): Promise<OrderBook> {
    const symbol = this.toSymbol(pair);
    const data = await this.publicGet<{
      bids: [string, string][];
      asks: [string, string][];
      T: number;
    }>("/fapi/v1/depth", { symbol, limit: String(depth) });

    return {
      pair,
      bids: data.bids.map(([p, s]) => [Number.parseFloat(p), Number.parseFloat(s)]),
      asks: data.asks.map(([p, s]) => [Number.parseFloat(p), Number.parseFloat(s)]),
      timestamp: new Date(data.T || Date.now()).toISOString(),
    };
  }

  async getCandles(
    pair: string,
    interval: string,
    limit = 100,
  ): Promise<Candle[]> {
    const symbol = this.toSymbol(pair);
    const data = await this.publicGet<
      [number, string, string, string, string, string, number, string, number, string, string, string][]
    >("/fapi/v1/klines", {
      symbol,
      interval: this.toBinanceInterval(interval),
      limit: String(limit),
    });

    return data.map((k) => ({
      timestamp: new Date(k[0]).toISOString(),
      open: Number.parseFloat(k[1]),
      high: Number.parseFloat(k[2]),
      low: Number.parseFloat(k[3]),
      close: Number.parseFloat(k[4]),
      volume: Number.parseFloat(k[5]),
    }));
  }

  async getBalance(): Promise<Balance> {
    const data = await this.signedGet<{
      totalWalletBalance: string;
      totalMarginBalance: string;
      totalUnrealizedProfit: string;
      availableBalance: string;
      totalInitialMargin: string;
    }>("/fapi/v2/account");

    return {
      equity: Number.parseFloat(data.totalMarginBalance),
      totalMarginUsed: Number.parseFloat(data.totalInitialMargin),
      availableMargin: Number.parseFloat(data.availableBalance),
      unrealizedPnl: Number.parseFloat(data.totalUnrealizedProfit),
    };
  }

  async getPositions(): Promise<Position[]> {
    const data = await this.signedGet<
      Array<{
        symbol: string;
        positionAmt: string;
        entryPrice: string;
        markPrice: string;
        unRealizedProfit: string;
        liquidationPrice: string;
        leverage: string;
        initialMargin: string;
        updateTime: number;
      }>
    >("/fapi/v2/positionRisk");

    return data
      .filter((p) => Number.parseFloat(p.positionAmt) !== 0)
      .map((p) => {
        const size = Number.parseFloat(p.positionAmt);
        return {
          pair: this.fromSymbol(p.symbol),
          side: size > 0 ? ("LONG" as const) : ("SHORT" as const),
          size: Math.abs(size),
          entryPrice: Number.parseFloat(p.entryPrice),
          currentPrice: Number.parseFloat(p.markPrice),
          leverage: Number.parseInt(p.leverage, 10),
          unrealizedPnl: Number.parseFloat(p.unRealizedProfit),
          realizedPnl: 0,
          liquidationPrice: Number.parseFloat(p.liquidationPrice),
          marginUsed: Number.parseFloat(p.initialMargin),
          openedAt: new Date(p.updateTime).toISOString(),
        };
      });
  }

  async placeOrder(params: PlaceOrderParams): Promise<OrderResult> {
    const body: Record<string, string> = {
      symbol: this.toSymbol(params.pair),
      side: params.side,
      type: params.type === "MARKET" ? "MARKET" : "LIMIT",
      quantity: String(params.size),
    };

    if (params.type === "LIMIT" && params.price !== undefined) {
      body.price = String(params.price);
      body.timeInForce = "GTC";
    }

    if (params.reduceOnly) {
      body.reduceOnly = "true";
    }

    const data = await this.signedPost<{
      orderId: number;
      status: string;
      executedQty: string;
      avgPrice: string;
      msg?: string;
    }>("/fapi/v1/order", body);

    const statusMap: Record<string, OrderResult["status"]> = {
      NEW: "PLACED",
      FILLED: "FILLED",
      PARTIALLY_FILLED: "PARTIALLY_FILLED",
      REJECTED: "REJECTED",
    };

    return {
      orderId: String(data.orderId),
      status: statusMap[data.status] ?? "PLACED",
      filledSize: Number.parseFloat(data.executedQty || "0"),
      avgFillPrice: Number.parseFloat(data.avgPrice || "0"),
      message: data.msg,
    };
  }

  async cancelOrder(orderId: string, pair: string): Promise<void> {
    await this.signedPost("/fapi/v1/order", {
      symbol: this.toSymbol(pair),
      orderId,
      _method: "DELETE",
    });
  }

  async getSupportedPairs(): Promise<string[]> {
    const data = await this.publicGet<{
      symbols: Array<{ symbol: string; contractType: string; status: string }>;
    }>("/fapi/v1/exchangeInfo", {});

    return data.symbols
      .filter((s) => s.contractType === "PERPETUAL" && s.status === "TRADING")
      .map((s) => this.fromSymbol(s.symbol));
  }

  // -----------------------------------------------------------------------
  // HTTP helpers with HMAC-SHA256 signing (Web Crypto API for CF Workers)
  // -----------------------------------------------------------------------

  private async publicGet<T>(path: string, params: Record<string, string>): Promise<T> {
    const qs = new URLSearchParams(params).toString();
    const url = `${this.baseUrl}${path}${qs ? `?${qs}` : ""}`;

    const res = await fetch(url, {
      headers: { "X-MBX-APIKEY": this.apiKey },
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Binance API error ${res.status}: ${text}`);
    }

    return res.json() as Promise<T>;
  }

  private async signedGet<T>(path: string, params: Record<string, string> = {}): Promise<T> {
    const timestamp = Date.now().toString();
    const allParams = { ...params, timestamp, recvWindow: "5000" };
    const queryString = new URLSearchParams(allParams).toString();
    const signature = await this.sign(queryString);
    const url = `${this.baseUrl}${path}?${queryString}&signature=${signature}`;

    const res = await fetch(url, {
      headers: { "X-MBX-APIKEY": this.apiKey },
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Binance API error ${res.status}: ${text}`);
    }

    return res.json() as Promise<T>;
  }

  private async signedPost<T>(path: string, params: Record<string, string>): Promise<T> {
    const timestamp = Date.now().toString();
    const allParams = { ...params, timestamp, recvWindow: "5000" };
    const queryString = new URLSearchParams(allParams).toString();
    const signature = await this.sign(queryString);

    const url = `${this.baseUrl}${path}`;
    const body = `${queryString}&signature=${signature}`;

    const res = await fetch(url, {
      method: "POST",
      headers: {
        "X-MBX-APIKEY": this.apiKey,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Binance API error ${res.status}: ${text}`);
    }

    return res.json() as Promise<T>;
  }

  /**
   * HMAC-SHA256 signature using Web Crypto API (CF Workers compatible).
   */
  private async sign(queryString: string): Promise<string> {
    const encoder = new TextEncoder();
    const keyData = encoder.encode(this.apiSecret);
    const msgData = encoder.encode(queryString);

    const key = await crypto.subtle.importKey(
      "raw",
      keyData,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );

    const signature = await crypto.subtle.sign("HMAC", key, msgData);
    const hashArray = Array.from(new Uint8Array(signature));
    return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  // -----------------------------------------------------------------------
  // Symbol mapping
  // -----------------------------------------------------------------------

  private toSymbol(pair: string): string {
    // Convert "ETH" -> "ETHUSDT", "BTC" -> "BTCUSDT"
    if (pair.endsWith("USDT")) return pair;
    return `${pair}USDT`;
  }

  private fromSymbol(symbol: string): string {
    // Convert "ETHUSDT" -> "ETH"
    return symbol.replace(/USDT$/, "");
  }

  private toBinanceInterval(interval: string): string {
    // Hyperliquid and Binance use similar intervals
    const map: Record<string, string> = {
      "1m": "1m",
      "3m": "3m",
      "5m": "5m",
      "15m": "15m",
      "30m": "30m",
      "1h": "1h",
      "2h": "2h",
      "4h": "4h",
      "8h": "8h",
      "12h": "12h",
      "1d": "1d",
      "1w": "1w",
    };
    return map[interval] ?? interval;
  }
}
