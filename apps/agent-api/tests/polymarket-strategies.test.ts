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
    expect((signal.metadata.source as string).startsWith("polymarket-scraper")).toBe(true);
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

  test("executes queued proposal after queueExecution", async () => {
    const strategy = createStrategy("POLYMARKET_EXECUTOR") as { queueExecution: (id: string, action: string, confidence: number) => void; analyze: typeof createStrategy extends (...a: never[]) => infer R ? R extends { analyze: infer A } ? A : never : never };
    (strategy as { queueExecution: (id: string, action: string, confidence: number) => void }).queueExecution("prop-123", "OPEN_LONG", 80);
    const signal = await (strategy as { analyze: (m: typeof mockMarketData, c: never[], p: never[]) => Promise<{ action: string; metadata: { proposalId?: string } }> }).analyze(mockMarketData, emptyCandles, emptyPositions);
    expect(signal.action).toBe("OPEN_LONG");
    expect(signal.metadata.proposalId).toBe("prop-123");
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

  test("reviewProposal approves high-confidence proposals", () => {
    const strategy = createStrategy("POLYMARKET_REVIEWER") as { reviewProposal: (p: { proposalId: string; action: string; confidence: number; rationale: string }) => { approved: boolean; reason: string } };
    const result = strategy.reviewProposal({
      proposalId: "prop-001",
      action: "OPEN_LONG",
      confidence: 80,
      rationale: "Strong signal",
    });
    expect(result.approved).toBe(true);
    expect(result.reason).toContain("Approved");
  });

  test("reviewProposal rejects low-confidence proposals", () => {
    const strategy = createStrategy("POLYMARKET_REVIEWER") as { reviewProposal: (p: { proposalId: string; action: string; confidence: number; rationale: string }) => { approved: boolean; reason: string } };
    const result = strategy.reviewProposal({
      proposalId: "prop-002",
      action: "OPEN_SHORT",
      confidence: 10,
      rationale: "Weak signal",
    });
    expect(result.approved).toBe(false);
    expect(result.reason).toContain("Rejected");
  });

  test("high risk tolerance lowers approval threshold", () => {
    const strategy = createStrategy("POLYMARKET_REVIEWER", { riskTolerance: "high" }) as { reviewProposal: (p: { proposalId: string; action: string; confidence: number; rationale: string }) => { approved: boolean; reason: string } };
    const result = strategy.reviewProposal({
      proposalId: "prop-003",
      action: "OPEN_LONG",
      confidence: 30,
      rationale: "Moderate signal",
    });
    // 40 * 0.7 = 28, so 30 should pass
    expect(result.approved).toBe(true);
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
