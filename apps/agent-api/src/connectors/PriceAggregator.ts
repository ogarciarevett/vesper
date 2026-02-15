/**
 * PriceAggregator - Collects and aggregates prices across multiple
 * market connectors to find the best execution venue.
 */

import type { MarketConnector, Ticker } from "./MarketConnector.js";

export interface PriceSnapshot {
  pair: string;
  exchange: string;
  bid: number;
  ask: number;
  midPrice: number;
  timestamp: string;
  depth: number;
}

export interface BestPrice {
  pair: string;
  bestBid: PriceSnapshot;
  bestAsk: PriceSnapshot;
  spread: number;
  venues: PriceSnapshot[];
}

export class PriceAggregator {
  private connectors: Map<string, MarketConnector> = new Map();
  private cache: Map<string, { snapshot: PriceSnapshot; expiry: number }[]> = new Map();
  private cacheTtlMs = 5_000; // 5 second cache

  addConnector(connector: MarketConnector): void {
    this.connectors.set(connector.name, connector);
  }

  removeConnector(name: string): void {
    this.connectors.delete(name);
  }

  /**
   * Get the best bid and ask prices across all connectors for a pair.
   */
  async getBestPrice(pair: string, side: "BUY" | "SELL"): Promise<BestPrice> {
    const snapshots = await this.getAllPrices(pair);

    if (snapshots.length === 0) {
      throw new Error(`No price data available for ${pair}`);
    }

    // Best bid = highest bid (best for selling)
    let bestBid = snapshots[0]!;
    for (const snap of snapshots) {
      if (snap.bid > bestBid.bid) {
        bestBid = snap;
      }
    }

    // Best ask = lowest ask (best for buying)
    let bestAsk = snapshots[0]!;
    for (const snap of snapshots) {
      if (snap.ask < bestAsk.ask) {
        bestAsk = snap;
      }
    }

    return {
      pair,
      bestBid,
      bestAsk,
      spread: bestAsk.ask - bestBid.bid,
      venues: snapshots,
    };
  }

  /**
   * Get price snapshots from all connectors for a given pair.
   */
  async getAllPrices(pair: string): Promise<PriceSnapshot[]> {
    const now = Date.now();

    // Check cache
    const cached = this.cache.get(pair);
    if (cached && cached.length > 0 && cached[0]!.expiry > now) {
      return cached.map((c) => c.snapshot);
    }

    // Fetch from all connectors in parallel
    const promises: Promise<PriceSnapshot | null>[] = [];

    for (const [, connector] of this.connectors) {
      promises.push(
        this.fetchTickerSafe(connector, pair),
      );
    }

    const results = await Promise.all(promises);
    const snapshots = results.filter((r): r is PriceSnapshot => r !== null);

    // Update cache
    this.cache.set(
      pair,
      snapshots.map((s) => ({ snapshot: s, expiry: now + this.cacheTtlMs })),
    );

    return snapshots;
  }

  private async fetchTickerSafe(
    connector: MarketConnector,
    pair: string,
  ): Promise<PriceSnapshot | null> {
    try {
      const ticker: Ticker = await connector.getTicker(pair);
      return {
        pair,
        exchange: connector.exchange,
        bid: ticker.bid,
        ask: ticker.ask,
        midPrice: ticker.midPrice,
        timestamp: ticker.timestamp,
        depth: 0, // Would need order book fetch for depth
      };
    } catch {
      // Connector doesn't support this pair or is unavailable
      return null;
    }
  }
}
