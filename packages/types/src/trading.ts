import type { OrderType, TradeAction, TradeSide } from "./agent";

/** Claude's trade decision response */
export interface TradeDecision {
	action: TradeAction;
	pair: string;
	size: number;
	leverage: number;
	orderType: OrderType;
	limitPrice?: number;
	stopLoss: number;
	takeProfit: number;
	rationale: string;
	confidence: number;
}

/** Position on Hyperliquid */
export interface Position {
	pair: string;
	side: TradeSide;
	size: number;
	entryPrice: number;
	currentPrice: number;
	leverage: number;
	unrealizedPnl: number;
	realizedPnl: number;
	liquidationPrice: number;
	marginUsed: number;
	openedAt: string;
}

/** Order submitted to Hyperliquid */
export interface Order {
	orderId: string;
	agentId: string;
	pair: string;
	side: TradeSide;
	type: OrderType;
	size: number;
	price?: number;
	leverage: number;
	status: OrderStatus;
	filledSize: number;
	avgFillPrice: number;
	createdAt: string;
	updatedAt: string;
}

export type OrderStatus =
	| "PENDING"
	| "OPEN"
	| "PARTIALLY_FILLED"
	| "FILLED"
	| "CANCELLED"
	| "REJECTED"
	| "EXPIRED";

/** PnL summary */
export interface PnlSummary {
	agentId: string;
	totalPnl: number;
	unrealizedPnl: number;
	realizedPnl: number;
	totalTrades: number;
	winRate: number;
	avgWin: number;
	avgLoss: number;
	maxDrawdown: number;
	sharpeRatio: number;
	periodStart: string;
	periodEnd: string;
}

/** Market data snapshot */
export interface MarketData {
	pair: string;
	timestamp: string;
	price: number;
	bid: number;
	ask: number;
	volume24h: number;
	change24hPct: number;
	fundingRate: number;
	openInterest: number;
	orderBook: OrderBookSnapshot;
}

export interface OrderBookSnapshot {
	bids: [number, number][]; // [price, size]
	asks: [number, number][]; // [price, size]
	timestamp: string;
}

/** Candle/OHLCV data */
export interface Candle {
	timestamp: string;
	open: number;
	high: number;
	low: number;
	close: number;
	volume: number;
}

/** Trading signal from a strategy skill */
export interface Signal {
	skillName: string;
	action: TradeAction;
	pair: string;
	confidence: number;
	metadata: Record<string, unknown>;
	timestamp: string;
}
