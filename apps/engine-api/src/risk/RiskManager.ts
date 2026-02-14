/**
 * RiskManager - Validates trade decisions against configurable risk limits.
 *
 * Performs all bot-level risk checks as defined in the TradingRoom spec:
 * - Position size limit
 * - Leverage limit
 * - Concurrent positions limit
 * - Stop-loss required
 * - Single trade loss limit
 * - Daily loss limit
 * - Drawdown check
 */

import type { Position, RiskConfig, TradeDecision, TradingConfig } from "@repo/types";

export interface RiskCheckResult {
  passed: boolean;
  reason?: string;
  checks: RiskCheckDetail[];
}

interface RiskCheckDetail {
  name: string;
  passed: boolean;
  detail: string;
}

export class RiskManager {
  private config: RiskConfig;
  private tradingConfig: TradingConfig;

  constructor(config: RiskConfig, tradingConfig: TradingConfig) {
    this.config = config;
    this.tradingConfig = tradingConfig;
  }

  /**
   * Run all risk checks against a proposed trade decision.
   *
   * @param decision - The trade decision to validate
   * @param currentPositions - Currently open positions
   * @param dailyPnl - Cumulative PnL for the current day (USD)
   * @param equity - Current account equity (USD)
   * @returns RiskCheckResult with pass/fail for each check
   */
  checkTrade(
    decision: TradeDecision,
    currentPositions: Position[],
    dailyPnl: number,
    equity: number,
  ): RiskCheckResult {
    // HOLD and CLOSE actions skip most checks
    if (decision.action === "HOLD") {
      return { passed: true, checks: [{ name: "action", passed: true, detail: "HOLD - no trade" }] };
    }

    if (decision.action === "CLOSE") {
      return { passed: true, checks: [{ name: "action", passed: true, detail: "CLOSE - reducing risk" }] };
    }

    const checks: RiskCheckDetail[] = [];

    // 1. Position size limit
    const positionValue = decision.size * (decision.limitPrice ?? 0);
    const positionSizeCheck = positionValue <= this.tradingConfig.maxPositionSizeUsd;
    checks.push({
      name: "positionSize",
      passed: positionSizeCheck,
      detail: positionSizeCheck
        ? `Position value $${positionValue.toFixed(2)} within limit $${this.tradingConfig.maxPositionSizeUsd}`
        : `Position value $${positionValue.toFixed(2)} exceeds limit $${this.tradingConfig.maxPositionSizeUsd}`,
    });

    // 2. Leverage limit
    const leverageCheck = decision.leverage <= this.tradingConfig.maxLeverage;
    checks.push({
      name: "leverage",
      passed: leverageCheck,
      detail: leverageCheck
        ? `Leverage ${decision.leverage}x within limit ${this.tradingConfig.maxLeverage}x`
        : `Leverage ${decision.leverage}x exceeds limit ${this.tradingConfig.maxLeverage}x`,
    });

    // 3. Concurrent positions limit
    const activePositionCount = currentPositions.filter((p) => p.size > 0).length;
    const newPositionAdded = decision.action === "OPEN_LONG" || decision.action === "OPEN_SHORT" ? 1 : 0;
    const concurrentCheck =
      activePositionCount + newPositionAdded <= this.tradingConfig.maxConcurrentPositions;
    checks.push({
      name: "concurrentPositions",
      passed: concurrentCheck,
      detail: concurrentCheck
        ? `${activePositionCount + newPositionAdded} positions within limit ${this.tradingConfig.maxConcurrentPositions}`
        : `${activePositionCount + newPositionAdded} positions would exceed limit ${this.tradingConfig.maxConcurrentPositions}`,
    });

    // 4. Stop-loss required
    let stopLossCheck = true;
    if (this.config.stopLossRequired) {
      stopLossCheck = decision.stopLoss > 0;
    }
    checks.push({
      name: "stopLoss",
      passed: stopLossCheck,
      detail: stopLossCheck
        ? this.config.stopLossRequired
          ? `Stop-loss set at ${decision.stopLoss}`
          : "Stop-loss not required"
        : "Stop-loss is required but not set",
    });

    // 5. Single trade loss limit
    let singleTradeLossCheck = true;
    if (decision.stopLoss > 0 && decision.limitPrice && decision.limitPrice > 0) {
      const priceDistance = Math.abs(decision.limitPrice - decision.stopLoss);
      const potentialLoss = priceDistance * decision.size;
      singleTradeLossCheck = potentialLoss <= this.config.maxSingleTradeLossUsd;
      checks.push({
        name: "singleTradeLoss",
        passed: singleTradeLossCheck,
        detail: singleTradeLossCheck
          ? `Potential loss $${potentialLoss.toFixed(2)} within limit $${this.config.maxSingleTradeLossUsd}`
          : `Potential loss $${potentialLoss.toFixed(2)} exceeds limit $${this.config.maxSingleTradeLossUsd}`,
      });
    } else {
      checks.push({
        name: "singleTradeLoss",
        passed: true,
        detail: "Cannot calculate potential loss without stop-loss and limit price",
      });
    }

    // 6. Daily loss limit
    const dailyLossCheck = Math.abs(Math.min(dailyPnl, 0)) < this.config.maxDailyLossUsd;
    checks.push({
      name: "dailyLoss",
      passed: dailyLossCheck,
      detail: dailyLossCheck
        ? `Daily loss $${Math.abs(Math.min(dailyPnl, 0)).toFixed(2)} within limit $${this.config.maxDailyLossUsd}`
        : `Daily loss $${Math.abs(dailyPnl).toFixed(2)} has reached limit $${this.config.maxDailyLossUsd}`,
    });

    // 7. Drawdown check
    // Drawdown is measured as percentage decline from equity peak
    // For now, we approximate: if current equity is significantly below starting,
    // and daily PnL shows losses approaching the drawdown threshold
    let drawdownCheck = true;
    if (equity > 0) {
      // Estimate drawdown from daily PnL as percentage of equity
      const drawdownPct = Math.abs(Math.min(dailyPnl, 0)) / equity * 100;
      drawdownCheck = drawdownPct < this.config.maxDrawdownPct;
      checks.push({
        name: "drawdown",
        passed: drawdownCheck,
        detail: drawdownCheck
          ? `Drawdown ${drawdownPct.toFixed(2)}% within limit ${this.config.maxDrawdownPct}%`
          : `Drawdown ${drawdownPct.toFixed(2)}% exceeds limit ${this.config.maxDrawdownPct}%`,
      });
    } else {
      checks.push({
        name: "drawdown",
        passed: true,
        detail: "Cannot calculate drawdown without equity data",
      });
    }

    // Aggregate results
    const allPassed = checks.every((c) => c.passed);
    const failedChecks = checks.filter((c) => !c.passed);

    return {
      passed: allPassed,
      reason: allPassed
        ? undefined
        : failedChecks.map((c) => `${c.name}: ${c.detail}`).join("; "),
      checks,
    };
  }

  /**
   * Check if the drawdown circuit breaker should trigger (force-stop the bot).
   */
  shouldForceStop(dailyPnl: number, equity: number): boolean {
    if (!this.config.forceStopOnDrawdown || equity <= 0) {
      return false;
    }

    const drawdownPct = Math.abs(Math.min(dailyPnl, 0)) / equity * 100;
    return drawdownPct >= this.config.maxDrawdownPct;
  }
}
