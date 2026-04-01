import type { AgentActivity, AgentState } from "./agent";
import type { Position } from "./trading";

/** Agent conversation message types */
export type AgentMessageType =
	| "THOUGHT"
	| "ANALYSIS"
	| "PROPOSAL"
	| "REVIEW"
	| "AGREEMENT"
	| "DISAGREEMENT"
	| "STATUS_UPDATE";

/** A message sent from one agent to another (or broadcast to room) */
export interface AgentMessagePayload {
	messageId: string;
	fromAgentId: string;
	toAgentId: string | null;
	content: string;
	messageType: AgentMessageType;
	replyToMessageId: string | null;
	timestamp: string;
}

/** Server -> Client: agent conversation message */
export interface AgentConversationMessage {
	type: "AGENT_MESSAGE";
	roomId: string;
	payload: AgentMessagePayload;
}

/** WebSocket message types from server to client */
export type ServerMessage =
	| StateDeltaMessage
	| FullStateMessage
	| ErrorMessage
	| PongMessage
	| RoomStateMessage
	| TradeEventMessage
	| AgentConversationMessage;

/** WebSocket message types from client to server */
export type ClientMessage =
	| SubscribeMessage
	| UnsubscribeMessage
	| PingMessage;

/** Delta state update (most common message) */
export interface StateDeltaMessage {
	type: "STATE_DELTA";
	agentId: string;
	seq: number;
	timestamp: string;
	changes: Partial<AgentRealtimeState>;
}

/** Full state snapshot (sent on initial connection) */
export interface FullStateMessage {
	type: "FULL_STATE";
	agentId: string;
	seq: number;
	timestamp: string;
	state: AgentRealtimeState;
}

/** Error message */
export interface ErrorMessage {
	type: "ERROR";
	code: string;
	message: string;
}

/** Pong response */
export interface PongMessage {
	type: "PONG";
	timestamp: string;
}

/** Aggregated room-level metrics */
export interface RoomStateMessage {
	type: "ROOM_STATE";
	roomId: string;
	timestamp: string;
	botCount: number;
	activeBotCount: number;
	totalPnl: number;
	totalPnlToday: number;
	totalExposure: number;
	riskStatus: "NORMAL" | "WARNING" | "BREACHED";
}

/** Trade lifecycle event emitted by a bot */
export interface TradeEventMessage {
	type: "TRADE_EVENT";
	agentId: string;
	timestamp: string;
	event: string;
	data: Record<string, unknown>;
}

/** Subscribe to agent updates */
export interface SubscribeMessage {
	type: "SUBSCRIBE";
	agentId: string;
}

/** Unsubscribe from agent updates */
export interface UnsubscribeMessage {
	type: "UNSUBSCRIBE";
	agentId: string;
}

/** Ping message */
export interface PingMessage {
	type: "PING";
}

/** Real-time agent state synced via WebSocket */
export interface AgentRealtimeState {
	agentId: string;
	doId?: string;
	state: AgentState;
	activity: AgentActivity;
	currentThought: string | null;
	positions: Position[];
	pnlTotal: number;
	pnlToday: number;
	tradeCountToday: number;
	lastTradeAt: string | null;
	/** Recent conversation message (displayed as chat bubble) */
	lastMessage: AgentMessagePayload | null;
	/** Position in the virtual office (Phaser coordinates) */
	visualPosition: {
		x: number;
		y: number;
		zone: VisualZone;
		animation: string;
	};
}

/** Zones in the virtual trading floor */
export type VisualZone =
	| "BREAK_ROOM"
	| "RESEARCH_DESK"
	| "CONFERENCE_TABLE"
	| "TRADING_TERMINAL"
	| "WATCH_TOWER"
	| "OWN_DESK"
	| "COFFEE_MACHINE";
