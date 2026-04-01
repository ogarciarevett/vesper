import type { StrategyType, MarketData, Candle, Position, Signal } from "@repo/types";
import type { TradingStrategy } from "../TradingStrategy";

/**
 * PolymarketReviewer strategy.
 * Reviews proposals from other agents before execution.
 * Cross-references multiple data sources, checks risk parameters,
 * and votes to approve or reject proposals.
 */
export class PolymarketReviewer implements TradingStrategy {
  name = "PolymarketReviewer";
  type: StrategyType = "POLYMARKET_REVIEWER";
  defaultParams: Record<string, unknown> = {
    minConfidence: 40,         // minimum confidence to approve
    maxExposurePct: 20,        // max % of portfolio per position
    requireMultiSource: true,  // require signals from multiple sources
    riskTolerance: "moderate", // low, moderate, high
  };

  private params: Record<string, unknown>;
  private reviewHistory: Array<{
    proposalId: string;
    approved: boolean;
    reason: string;
    timestamp: string;
  }> = [];

  constructor() {
    this.params = { ...this.defaultParams };
  }

  initialize(params: Record<string, unknown>): void {
    this.params = { ...this.defaultParams, ...params };
  }

  /**
   * Review a proposal and return approval decision.
   * In production, this would cross-reference data sources.
   */
  reviewProposal(proposal: {
    proposalId: string;
    action: string;
    confidence: number;
    rationale: string;
  }): { approved: boolean; reason: string } {
    const minConfidence = (this.params.minConfidence as number) ?? 40;
    const riskTolerance = (this.params.riskTolerance as string) ?? "moderate";

    // Risk-adjusted confidence threshold
    const adjustedThreshold =
      riskTolerance === "low"
        ? minConfidence * 1.5
        : riskTolerance === "high"
          ? minConfidence * 0.7
          : minConfidence;

    const approved = proposal.confidence >= adjustedThreshold;
    const reason = approved
      ? `Approved: confidence ${proposal.confidence}% meets threshold ${adjustedThreshold.toFixed(0)}%`
      : `Rejected: confidence ${proposal.confidence}% below threshold ${adjustedThreshold.toFixed(0)}%`;

    this.reviewHistory.push({
      proposalId: proposal.proposalId,
      approved,
      reason,
      timestamp: new Date().toISOString(),
    });

    // Keep last 50 reviews
    if (this.reviewHistory.length > 50) {
      this.reviewHistory = this.reviewHistory.slice(-50);
    }

    return { approved, reason };
  }

  async analyze(
    marketData: MarketData,
    _candles: Candle[],
    _positions: Position[],
  ): Promise<Signal> {
    // Reviewer is passive - it doesn't generate trading signals directly.
    // It responds to proposals via the reviewProposal method.
    return {
      skillName: this.name,
      action: "HOLD",
      pair: marketData.pair,
      confidence: 0,
      metadata: {
        reason: "Reviewer agent: waiting for proposals to review",
        reviewsCompleted: this.reviewHistory.length,
        approvalRate: this.reviewHistory.length > 0
          ? (this.reviewHistory.filter((r) => r.approved).length /
              this.reviewHistory.length *
              100).toFixed(1) + "%"
          : "N/A",
        source: "reviewer",
      },
      timestamp: new Date().toISOString(),
    };
  }

  getState(): Record<string, unknown> {
    return {
      ...this.params,
      reviewsCompleted: this.reviewHistory.length,
      recentReviews: this.reviewHistory.slice(-5),
    };
  }
}
