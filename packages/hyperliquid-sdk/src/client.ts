import type { PrivateKeyAccount } from "viem";
import {
  accountFromPrivateKey,
  generateNonce,
  signExchangeAction,
} from "./auth.js";
import { MAINNET, RATE_LIMITS, TESTNET } from "./constants.js";
import {
  cancelOrders,
  closePosition,
  modifyOrders,
  placeOrders,
  placeTriggerOrders,
  updateLeverage,
} from "./orders.js";
import { getAccountInfo, getOpenOrders, getPositions } from "./positions.js";
import {
  getAllMids,
  getCandles,
  getFundingHistory,
  getFundingRates,
  getL2Book,
  getMeta,
  getRecentTrades,
} from "./market-data.js";
import type {
  AccountInfo,
  CancelOrderParams,
  ClosePositionParams,
  ExchangeAction,
  ExchangeResponse,
  HyperliquidConfig,
  InfoRequest,
  ModifyOrderParams,
  ParsedPosition,
  PlaceOrderParams,
  PlaceTriggerOrderParams,
  OpenOrder,
  UniverseMeta,
  AllMidsResponse,
  L2BookResponse,
  RawTrade,
  RawCandle,
  FundingEntry,
  PredictedFunding,
} from "./types.js";
import type { CandleInterval } from "./constants.js";

// ---------------------------------------------------------------------------
// Token-bucket rate limiter (Cloudflare Workers compatible -- no timers)
// ---------------------------------------------------------------------------

class RateLimiter {
  private tokens: number;
  private readonly maxTokens: number;
  private readonly refillRatePerMs: number;
  private lastRefill: number;

  constructor(config: { maxTokens: number; refillRatePerSec: number }) {
    this.maxTokens = config.maxTokens;
    this.tokens = config.maxTokens;
    this.refillRatePerMs = config.refillRatePerSec / 1000;
    this.lastRefill = Date.now();
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    this.tokens = Math.min(
      this.maxTokens,
      this.tokens + elapsed * this.refillRatePerMs,
    );
    this.lastRefill = now;
  }

  async acquire(): Promise<void> {
    this.refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return;
    }
    // Wait until a token is available
    const waitMs = Math.ceil((1 - this.tokens) / this.refillRatePerMs);
    await new Promise<void>((resolve) => setTimeout(resolve, waitMs));
    this.refill();
    this.tokens -= 1;
  }
}

// ---------------------------------------------------------------------------
// HyperliquidClient
// ---------------------------------------------------------------------------

export class HyperliquidClient {
  readonly infoUrl: string;
  readonly exchangeUrl: string;
  readonly wsUrl: string;
  readonly testnet: boolean;

  private account: PrivateKeyAccount | null;
  private walletAddress: string | null;
  private assetIndexCache: Map<string, number> | null = null;

  private rateLimiters = {
    info: new RateLimiter(RATE_LIMITS.info),
    exchange: new RateLimiter(RATE_LIMITS.exchange),
    orders: new RateLimiter(RATE_LIMITS.orders),
  };

  constructor(config: HyperliquidConfig = {}) {
    this.testnet = config.testnet ?? false;
    const endpoints = this.testnet ? TESTNET : MAINNET;

    this.infoUrl = config.restUrl
      ? `${config.restUrl}/info`
      : endpoints.INFO_URL;
    this.exchangeUrl = config.restUrl
      ? `${config.restUrl}/exchange`
      : endpoints.EXCHANGE_URL;
    this.wsUrl = config.wsUrl ?? endpoints.WS_URL;

    if (config.privateKey) {
      this.account = accountFromPrivateKey(config.privateKey);
      this.walletAddress =
        config.walletAddress ?? this.account.address;
    } else {
      this.account = null;
      this.walletAddress = config.walletAddress ?? null;
    }
  }

  // -----------------------------------------------------------------------
  // Low-level API helpers
  // -----------------------------------------------------------------------

  /** Send a POST to the info endpoint */
  async infoRequest<T = unknown>(body: InfoRequest): Promise<T> {
    await this.rateLimiters.info.acquire();
    const res = await fetch(this.infoUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Hyperliquid info API error ${res.status}: ${text}`);
    }
    return res.json() as Promise<T>;
  }

  /** Send a signed POST to the exchange endpoint */
  async exchangeRequest(action: ExchangeAction): Promise<ExchangeResponse> {
    if (!this.account) {
      throw new Error(
        "Private key required for exchange requests. Pass privateKey in config.",
      );
    }

    await this.rateLimiters.exchange.acquire();

    const nonce = generateNonce();
    const signature = await signExchangeAction(
      action,
      nonce,
      this.account,
      this.testnet,
    );

    const res = await fetch(this.exchangeUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, nonce, signature }),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Hyperliquid exchange API error ${res.status}: ${text}`);
    }

    return res.json() as Promise<ExchangeResponse>;
  }

  /** Resolve a coin symbol to its asset index, caching the result */
  async getAssetIndex(coin: string): Promise<number> {
    if (!this.assetIndexCache) {
      const meta = await this.getMeta();
      this.assetIndexCache = new Map();
      for (let i = 0; i < meta.universe.length; i++) {
        const asset = meta.universe[i];
        if (asset) {
          this.assetIndexCache.set(asset.name, i);
        }
      }
    }
    const idx = this.assetIndexCache.get(coin);
    if (idx === undefined) {
      throw new Error(`Unknown asset: ${coin}`);
    }
    return idx;
  }

  /** Get the wallet address (or throw if not configured) */
  getWalletAddress(): string {
    if (!this.walletAddress) {
      throw new Error(
        "Wallet address not configured. Pass privateKey or walletAddress in config.",
      );
    }
    return this.walletAddress;
  }

  // -----------------------------------------------------------------------
  // Market Data
  // -----------------------------------------------------------------------

  /** Fetch metadata about all available assets */
  async getMeta(): Promise<UniverseMeta> {
    return getMeta(this);
  }

  /** Fetch current mid prices for all assets */
  async getAllMids(): Promise<AllMidsResponse> {
    return getAllMids(this);
  }

  /** Fetch L2 order book for a coin */
  async getOrderBook(coin: string): Promise<L2BookResponse> {
    return getL2Book(this, coin);
  }

  /** Fetch recent trades for a coin */
  async getRecentTrades(coin: string): Promise<RawTrade[]> {
    return getRecentTrades(this, coin);
  }

  /** Fetch candle data */
  async getCandles(
    coin: string,
    interval: CandleInterval,
    startTime: number,
    endTime: number,
  ): Promise<RawCandle[]> {
    return getCandles(this, coin, interval, startTime, endTime);
  }

  /** Fetch a ticker (mid price) for a single coin */
  async getTicker(coin: string): Promise<{ coin: string; midPrice: number }> {
    const mids = await this.getAllMids();
    const mid = mids[coin];
    if (mid === undefined) {
      throw new Error(`No mid price for ${coin}`);
    }
    return { coin, midPrice: Number.parseFloat(mid) };
  }

  /** Fetch funding rate history for a coin */
  async getFundingHistory(
    coin: string,
    startTime: number,
    endTime: number,
  ): Promise<FundingEntry[]> {
    return getFundingHistory(this, coin, startTime, endTime);
  }

  /** Fetch current and predicted funding rates */
  async getFundingRates(): Promise<PredictedFunding[]> {
    return getFundingRates(this);
  }

  // -----------------------------------------------------------------------
  // Account / Positions
  // -----------------------------------------------------------------------

  /** Get parsed positions for the configured wallet */
  async getPositions(): Promise<ParsedPosition[]> {
    return getPositions(this);
  }

  /** Get open orders for the configured wallet */
  async getOpenOrders(): Promise<OpenOrder[]> {
    return getOpenOrders(this);
  }

  /** Get full account info (equity, margin, positions) */
  async getAccountInfo(): Promise<AccountInfo> {
    return getAccountInfo(this);
  }

  // -----------------------------------------------------------------------
  // Order Management
  // -----------------------------------------------------------------------

  /** Place one or more orders */
  async placeOrder(
    params: PlaceOrderParams | PlaceOrderParams[],
  ): Promise<ExchangeResponse> {
    const arr = Array.isArray(params) ? params : [params];
    return placeOrders(this, arr);
  }

  /** Place a trigger (stop-loss / take-profit) order */
  async placeTriggerOrder(
    params: PlaceTriggerOrderParams | PlaceTriggerOrderParams[],
  ): Promise<ExchangeResponse> {
    const arr = Array.isArray(params) ? params : [params];
    return placeTriggerOrders(this, arr);
  }

  /** Cancel one or more orders */
  async cancelOrder(
    params: CancelOrderParams | CancelOrderParams[],
  ): Promise<ExchangeResponse> {
    const arr = Array.isArray(params) ? params : [params];
    return cancelOrders(this, arr);
  }

  /** Modify one or more existing orders (atomic cancel + replace) */
  async modifyOrder(
    params: ModifyOrderParams | ModifyOrderParams[],
  ): Promise<ExchangeResponse> {
    const arr = Array.isArray(params) ? params : [params];
    return modifyOrders(this, arr);
  }

  /** Close a position (fully or partially) */
  async closePosition(params: ClosePositionParams): Promise<ExchangeResponse> {
    return closePosition(this, params);
  }

  /** Update leverage for an asset */
  async updateLeverage(
    coin: string,
    leverage: number,
    isCross = true,
  ): Promise<ExchangeResponse> {
    return updateLeverage(this, coin, leverage, isCross);
  }
}
