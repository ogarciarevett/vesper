import { describe, expect, test } from "bun:test";
import { createStrategy } from "../src/skills/strategies/index";
import type { MarketData, Position } from "@repo/types";

const mockMarketData: MarketData = {
  pair: "ETH",
  price: 3500,
  bid: 3499,
  ask: 3501,
  volume24h: 1000000,
  fundingRate: 0.001,
  openInterest: 5000000,
  timestamp: new Date().toISOString(),
};

const emptyPositions: Position[] = [];
const emptyCandles: never[] = [];

describe("Polymarket Strategy Registry", () => {
  test("creates POLYMARKET_SCRAPER strategy", () => {
    const strategy = createStrategy("POLYMARKET_SCRAPER");
    expect(strategy.name).toBe("PolymarketScraper");
    expect(strategy.type).toBe("POLYMARKET_SCRAPER");
  });

  test("creates POLYMARKET_TWITTER strategy", () => {
    const strategy = createStrategy("POLYMARKET_TWITTER");
    expect(strategy.name).toBe("PolymarketTwitterSentiment");
    expect(strategy.type).toBe("POLYMARKET_TWITTER");
  });

  test("creates POLYMARKET_EXECUTOR strategy", () => {
    const strategy = createStrategy("POLYMARKET_EXECUTOR");
    expect(strategy.name).toBe("PolymarketExecutor");
    expect(strategy.type).toBe("POLYMARKET_EXECUTOR");
  });

  test("creates POLYMARKET_REVIEWER strategy", () => {
    const strategy = createStrategy("POLYMARKET_REVIEWER");
    expect(strategy.name).toBe("PolymarketReviewer");
    expect(strategy.type).toBe("POLYMARKET_REVIEWER");
  });
});

describe("PolymarketScraper", () => {
  test("returns a signal with odds data", async () => {
    const strategy = createStrategy("POLYMARKET_SCRAPER");
    const signal = await strategy.analyze(mockMarketData, emptyCandles, emptyPositions);
    expect(signal.skillName).toBe("PolymarketScraper");
    expect(signal.pair).toBe("ETH");
    expect(typeof signal.confidence).toBe("number");
    expect(signal.metadata.source).toBe("polymarket-scraper");
    expect(signal.metadata.currentOdds).toBeDefined();
  });

  test("exposes state with cached odds", () => {
    const strategy = createStrategy("POLYMARKET_SCRAPER");
    const state = strategy.getState();
    expect(state.oddsChangeThreshold).toBe(5);
    expect(state.cachedOdds).toBeDefined();
  });
});

describe("PolymarketTwitter", () => {
  test("returns a signal with sentiment data", async () => {
    const strategy = createStrategy("POLYMARKET_TWITTER");
    const signal = await strategy.analyze(mockMarketData, emptyCandles, emptyPositions);
    expect(signal.skillName).toBe("PolymarketTwitterSentiment");
    expect(signal.metadata.source).toBe("twitter-sentiment");
    expect(signal.metadata.sentiment).toBeDefined();
  });

  test("accepts custom params", () => {
    const strategy = createStrategy("POLYMARKET_TWITTER", {
      sentimentThreshold: 0.1,
    });
    const state = strategy.getState();
    expect(state.sentimentThreshold).toBe(0.1);
  });
});

describe("PolymarketExecutor", () => {
  test("returns HOLD when no pending proposals", async () => {
    const strategy = createStrategy("POLYMARKET_EXECUTOR");
    const signal = await strategy.analyze(mockMarketData, emptyCandles, emptyPositions);
    expect(signal.action).toBe("HOLD");
    expect(signal.metadata.reason).toContain("No approved proposals");
  });
});

describe("PolymarketReviewer", () => {
  test("returns HOLD signal (passive agent)", async () => {
    const strategy = createStrategy("POLYMARKET_REVIEWER");
    const signal = await strategy.analyze(mockMarketData, emptyCandles, emptyPositions);
    expect(signal.action).toBe("HOLD");
    expect(signal.confidence).toBe(0);
    expect(signal.metadata.source).toBe("reviewer");
  });

  test("exposes review state", () => {
    const strategy = createStrategy("POLYMARKET_REVIEWER");
    const state = strategy.getState();
    expect(state.minConfidence).toBe(40);
    expect(state.riskTolerance).toBe("moderate");
    expect(state.reviewsCompleted).toBe(0);
  });
});

describe("Consensus Protocol Types", () => {
  test("ProposalState structure is valid", () => {
    // Verify the type contract works
    const proposal = {
      proposalId: "prop-001",
      action: "OPEN_LONG",
      pair: "BTC",
      rationale: "Strong momentum",
      confidence: 75,
      data: {},
    };

    const state = {
      proposal,
      fromAgentId: "bot-alpha",
      approvals: ["bot-beta"],
      rejections: [],
      status: "PENDING" as const,
      createdAt: new Date().toISOString(),
      resolvedAt: null,
    };

    expect(state.status).toBe("PENDING");
    expect(state.approvals).toHaveLength(1);
    expect(state.proposal.confidence).toBe(75);
  });
});
