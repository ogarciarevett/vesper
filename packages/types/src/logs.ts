import type { TradeDecision } from "./trading";

/** Log entry types */
export type LogType =
	| "DECISION"
	| "ORDER"
	| "FILL"
	| "STATE_CHANGE"
	| "ERROR"
	| "SYSTEM";

/** Base log entry */
export interface LogEntry {
	id: string;
	agentId: string;
	timestamp: string;
	type: LogType;
	data: LogData;
	prevHash: string;
}

/** Union of log data types */
export type LogData =
	| DecisionLogData
	| OrderLogData
	| FillLogData
	| StateChangeLogData
	| ErrorLogData
	| SystemLogData;

/** Decision cycle log */
export interface DecisionLogData {
	type: "DECISION";
	marketContext: Record<string, unknown>;
	prompt: string;
	response: string;
	decision: TradeDecision;
	riskCheckPassed: boolean;
	riskCheckReason?: string;
	durationMs: number;
}

/** Order placement log */
export interface OrderLogData {
	type: "ORDER";
	orderId: string;
	pair: string;
	side: string;
	orderType: string;
	size: number;
	price?: number;
	status: string;
}

/** Fill log */
export interface FillLogData {
	type: "FILL";
	orderId: string;
	pair: string;
	side: string;
	filledSize: number;
	avgPrice: number;
	fee: number;
}

/** State change log */
export interface StateChangeLogData {
	type: "STATE_CHANGE";
	fromState: string;
	toState: string;
	reason: string;
}

/** Error log */
export interface ErrorLogData {
	type: "ERROR";
	errorCode: string;
	message: string;
	stack?: string;
	context?: Record<string, unknown>;
}

/** System event log */
export interface SystemLogData {
	type: "SYSTEM";
	event: string;
	details?: Record<string, unknown>;
}
