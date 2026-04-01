import type { StrategyType, MarketData, Candle, Position, Signal } from "@repo/types";
import type { TradingStrategy } from "../TradingStrategy";
import { scrapePolymarket } from "./firecrawl.js";

/**
 * PolymarketScraper strategy.
 * Scrapes market data from Polymarket using Firecrawl REST API.
 * Falls back to simulated odds when FIRECRAWL_API_KEY is not configured.
 * Generates signals based on market odds movements and volume.
 */
export class PolymarketScraper implements TradingStrategy {
  name = "PolymarketScraper";
  type: StrategyType = "POLYMARKET_SCRAPER";
  defaultParams: Record<string, unknown> = {
    oddsChangeThreshold: 5,    // minimum % change in odds to signal
    volumeMinUsd: 1000,        // minimum 24h volume
    refreshIntervalMs: 30000,  // how often to re-scrape
    markets: [],               // list of market slugs to monitor
    firecrawlApiKey: "",       // injected from env by BotInstance
  };

  private params: Record<string, unknown>;
  private lastScrapeAt = 0;
  private cachedOdds: Map<string, number> = new Map();
  private scrapeSource: "firecrawl" | "simulated" = "simulated";

  constructor() {
    this.params = { ...this.defaultParams };
  }

  initialize(params: Record<string, unknown>): void {
    this.params = { ...this.defaultParams, ...params };
  }

  private async fetchOdds(marketPair: string): Promise<number> {
    const apiKey = this.params.firecrawlApiKey as string;
    const markets = this.params.markets as string[];

    // Try Firecrawl if API key is configured
    if (apiKey && apiKey.length > 0) {
      // Use market slug from config, or derive from pair name
      const slug = markets[0] ?? marketPair.toLowerCase();
      const scraped = await scrapePolymarket(apiKey, slug);
      if (scraped) {
        this.scrapeSource = "firecrawl";
        return scraped.yes;
      }
    }

    // Fallback: simulated odds movement
    this.scrapeSource = "simulated";
    const previousOdds = this.cachedOdds.get(marketPair) ?? 50;
    return Math.min(99, Math.max(1, previousOdds + (Math.random() - 0.5) * 10));
  }

  async analyze(
    marketData: MarketData,
    _candles: Candle[],
    _positions: Position[],
  ): Promise<Signal> {
    const now = Date.now();
    const refreshInterval = (this.params.refreshIntervalMs as number) ?? 30000;
    const threshold = (this.params.oddsChangeThreshold as number) ?? 5;

    const previousOdds = this.cachedOdds.get(marketData.pair) ?? 50;
    let currentOdds = previousOdds;

    // Re-scrape on interval
    if (now - this.lastScrapeAt > refreshInterval) {
      this.lastScrapeAt = now;
      currentOdds = await this.fetchOdds(marketData.pair);
    }

    const oddsChange = currentOdds - previousOdds;
    this.cachedOdds.set(marketData.pair, currentOdds);

    if (Math.abs(oddsChange) >= threshold) {
      const action = oddsChange > 0 ? "OPEN_LONG" : "OPEN_SHORT";
      return {
        skillName: this.name,
        action,
        pair: marketData.pair,
        confidence: Math.min(90, 40 + Math.abs(oddsChange) * 3),
        metadata: {
          reason: `Odds shifted ${oddsChange > 0 ? "+" : ""}${oddsChange.toFixed(1)}% to ${currentOdds.toFixed(1)}%`,
          currentOdds,
          previousOdds,
          oddsChange,
          source: `polymarket-scraper (${this.scrapeSource})`,
          proposalReady: true,
        },
        timestamp: new Date().toISOString(),
      };
    }

    return {
      skillName: this.name,
      action: "HOLD",
      pair: marketData.pair,
      confidence: 20,
      metadata: {
        reason: `Odds stable at ${currentOdds.toFixed(1)}% (change: ${oddsChange.toFixed(1)}%)`,
        currentOdds,
        source: `polymarket-scraper (${this.scrapeSource})`,
      },
      timestamp: new Date().toISOString(),
    };
  }

  getState(): Record<string, unknown> {
    return {
      ...this.params,
      firecrawlApiKey: this.params.firecrawlApiKey ? "***" : "",
      lastScrapeAt: this.lastScrapeAt,
      scrapeSource: this.scrapeSource,
      cachedOdds: Object.fromEntries(this.cachedOdds),
    };
  }
}
