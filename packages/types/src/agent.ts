/** Agent lifecycle states */
export type AgentState =
	| "CREATED"
	| "CONFIGURING"
	| "READY"
	| "RUNNING"
	| "PAUSED"
	| "STOPPED"
	| "ERROR"
	| "ARCHIVED";

/** Agent activity within RUNNING state */
export type AgentActivity =
	| "IDLE"
	| "ANALYZING"
	| "DECIDING"
	| "EXECUTING"
	| "MONITORING"
	| "COOLDOWN";

/** Strategy types */
export type StrategyType =
	| "MOMENTUM_SCALPER"
	| "SENTIMENT_ANALYZER"
	| "MEAN_REVERSION"
	| "BREAKOUT_HUNTER"
	| "GRID_TRADER"
	| "POLYMARKET_SCRAPER"
	| "POLYMARKET_TWITTER"
	| "POLYMARKET_EXECUTOR"
	| "POLYMARKET_REVIEWER";

/** Room types for different verticals */
export type RoomType = "TRADING" | "PREDICTION_MARKET";

/** Agent appearance configuration for visualization */
export interface AgentAppearance {
	spriteId: string;
	accentColor: string;
	voiceId: string;
}

/** Agent configuration */
export interface AgentConfig {
	agentId: string;
	name: string;
	ownerId: string;
	strategy: StrategyConfig;
	trading: TradingConfig;
	risk: RiskConfig;
	reasoning: ReasoningConfig;
	appearance?: AgentAppearance;
}

export interface StrategyConfig {
	type: StrategyType;
	params: Record<string, unknown>;
}

export interface TradingConfig {
	pairs: string[];
	maxLeverage: number;
	maxPositionSizeUsd: number;
	maxConcurrentPositions: number;
	orderTypes: OrderType[];
}

export interface RiskConfig {
	maxDrawdownPct: number;
	maxDailyLossUsd: number;
	maxSingleTradeLossUsd: number;
	stopLossRequired: boolean;
	forceStopOnDrawdown: boolean;
}

export interface ReasoningConfig {
	model: string;
	byokAlias?: string;
	intervalSeconds: number;
	temperature: number;
	maxTokens: number;
}

/** Agent summary for API responses */
export interface Agent {
	id: string;
	name: string;
	ownerId: string;
	state: AgentState;
	activity: AgentActivity;
	config: AgentConfig;
	createdAt: string;
	updatedAt: string;
	startedAt: string | null;
	stoppedAt: string | null;
}

/** Order types */
export type OrderType = "MARKET" | "LIMIT" | "STOP_LOSS" | "TAKE_PROFIT";

/** Trade side */
export type TradeSide = "LONG" | "SHORT";

/** Trade action from Claude decision */
export type TradeAction =
	| "OPEN_LONG"
	| "OPEN_SHORT"
	| "CLOSE"
	| "HOLD"
	| "ADJUST";
