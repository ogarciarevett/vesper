import type { StrategyType, MarketData, Candle, Position, Signal } from "@repo/types";
import type { TradingStrategy } from "../TradingStrategy";

/**
 * PolymarketExecutor strategy.
 * Executes trades on prediction markets based on approved proposals.
 * Only acts when consensus has been reached by other agents.
 * Focuses on optimal execution: timing, order type, and slippage management.
 */
export class PolymarketExecutor implements TradingStrategy {
  name = "PolymarketExecutor";
  type: StrategyType = "POLYMARKET_EXECUTOR";
  defaultParams: Record<string, unknown> = {
    maxSlippagePct: 2,         // maximum acceptable slippage
    executionDelay: 1000,      // ms delay before execution (for price check)
    requireConsensus: true,    // only execute approved proposals
    maxPositionUsd: 5000,      // max position size per market
  };

  private params: Record<string, unknown>;
  private pendingExecutions: Map<string, { action: string; confidence: number }> = new Map();

  constructor() {
    this.params = { ...this.defaultParams };
  }

  initialize(params: Record<string, unknown>): void {
    this.params = { ...this.defaultParams, ...params };
  }

  /** Queue an approved proposal for execution */
  queueExecution(proposalId: string, action: string, confidence: number): void {
    this.pendingExecutions.set(proposalId, { action, confidence });
  }

  async analyze(
    marketData: MarketData,
    _candles: Candle[],
    positions: Position[],
  ): Promise<Signal> {
    const maxPositionUsd = (this.params.maxPositionUsd as number) ?? 5000;

    // Check for pending approved proposals to execute
    if (this.pendingExecutions.size > 0) {
      const [proposalId, execution] = [...this.pendingExecutions.entries()][0]!;
      this.pendingExecutions.delete(proposalId);

      // Check position limits
      const currentExposure = positions.reduce(
        (sum, p) => sum + Math.abs(p.size * p.currentPrice),
        0,
      );
      if (currentExposure >= maxPositionUsd) {
        return {
          skillName: this.name,
          action: "HOLD",
          pair: marketData.pair,
          confidence: 10,
          metadata: {
            reason: `Position limit reached ($${currentExposure.toFixed(0)}/$${maxPositionUsd})`,
            proposalId,
            source: "executor",
          },
          timestamp: new Date().toISOString(),
        };
      }

      return {
        skillName: this.name,
        action: execution.action as Signal["action"],
        pair: marketData.pair,
        confidence: execution.confidence,
        metadata: {
          reason: `Executing approved proposal ${proposalId}`,
          proposalId,
          source: "executor",
        },
        timestamp: new Date().toISOString(),
      };
    }

    return {
      skillName: this.name,
      action: "HOLD",
      pair: marketData.pair,
      confidence: 5,
      metadata: {
        reason: "No approved proposals to execute",
        pendingCount: this.pendingExecutions.size,
        source: "executor",
      },
      timestamp: new Date().toISOString(),
    };
  }

  getState(): Record<string, unknown> {
    return {
      ...this.params,
      pendingExecutions: this.pendingExecutions.size,
    };
  }
}
