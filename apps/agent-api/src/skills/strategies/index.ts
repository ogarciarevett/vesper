/**
 * Strategy registry - maps StrategyType to strategy class instances.
 */

import type { StrategyType } from "@repo/types";
import { MomentumScalper } from "./MomentumScalper.js";
import { MeanReversion } from "./MeanReversion.js";
import { BreakoutHunter } from "./BreakoutHunter.js";
import { GridTrader } from "./GridTrader.js";
import { FundingRateArbitrage } from "./FundingRateArbitrage.js";

export type StrategyInstance =
  | MomentumScalper
  | MeanReversion
  | BreakoutHunter
  | GridTrader
  | FundingRateArbitrage;

/**
 * Create a strategy instance by type.
 */
export function createStrategy(
  type: StrategyType | "FUNDING_RATE_ARB",
  params: Record<string, unknown> = {},
): StrategyInstance {
  let strategy: StrategyInstance;

  switch (type) {
    case "MOMENTUM_SCALPER":
      strategy = new MomentumScalper();
      break;
    case "MEAN_REVERSION":
      strategy = new MeanReversion();
      break;
    case "BREAKOUT_HUNTER":
      strategy = new BreakoutHunter();
      break;
    case "GRID_TRADER":
      strategy = new GridTrader();
      break;
    case "FUNDING_RATE_ARB":
      strategy = new FundingRateArbitrage();
      break;
    default: {
      // Default to momentum scalper for unknown types
      strategy = new MomentumScalper();
      break;
    }
  }

  strategy.initialize(params);
  return strategy;
}

export { MomentumScalper } from "./MomentumScalper.js";
export { MeanReversion } from "./MeanReversion.js";
export { BreakoutHunter } from "./BreakoutHunter.js";
export { GridTrader } from "./GridTrader.js";
export { FundingRateArbitrage } from "./FundingRateArbitrage.js";
