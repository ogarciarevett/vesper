import type { CandleInterval } from "./constants.js";

// ---------------------------------------------------------------------------
// SDK Configuration
// ---------------------------------------------------------------------------

export interface HyperliquidConfig {
  /** Use testnet instead of mainnet */
  testnet?: boolean;
  /** Wallet private key (hex string, with or without 0x prefix) */
  privateKey?: string;
  /** Wallet address override (derived from privateKey if not set) */
  walletAddress?: string;
  /** Custom REST base URL (overrides testnet flag) */
  restUrl?: string;
  /** Custom WebSocket URL (overrides testnet flag) */
  wsUrl?: string;
}

// ---------------------------------------------------------------------------
// Info API Request Types
// ---------------------------------------------------------------------------

export interface MetaRequest {
  type: "meta";
}

export interface AllMidsRequest {
  type: "allMids";
}

export interface L2BookRequest {
  type: "l2Book";
  coin: string;
}

export interface RecentTradesRequest {
  type: "recentTrades";
  coin: string;
}

export interface CandleSnapshotRequest {
  type: "candleSnapshot";
  req: {
    coin: string;
    interval: CandleInterval;
    startTime: number;
    endTime: number;
  };
}

export interface ClearinghouseStateRequest {
  type: "clearinghouseState";
  user: string;
}

export interface OpenOrdersRequest {
  type: "openOrders";
  user: string;
}

export interface UserFillsRequest {
  type: "userFills";
  user: string;
}

export interface UserFundingRequest {
  type: "userFunding";
  user: string;
  startTime: number;
  endTime: number;
}

export interface FundingHistoryRequest {
  type: "fundingHistory";
  coin: string;
  startTime: number;
  endTime: number;
}

export interface PredictedFundingsRequest {
  type: "predictedFundings";
}

export type InfoRequest =
  | MetaRequest
  | AllMidsRequest
  | L2BookRequest
  | RecentTradesRequest
  | CandleSnapshotRequest
  | ClearinghouseStateRequest
  | OpenOrdersRequest
  | UserFillsRequest
  | UserFundingRequest
  | FundingHistoryRequest
  | PredictedFundingsRequest;

// ---------------------------------------------------------------------------
// Info API Response Types
// ---------------------------------------------------------------------------

export interface AssetMeta {
  name: string;
  szDecimals: number;
  maxLeverage: number;
  onlyIsolated: boolean;
}

export interface UniverseMeta {
  universe: AssetMeta[];
}

export interface AllMidsResponse {
  [coin: string]: string;
}

export interface L2BookLevel {
  /** [price, size] */
  px: string;
  sz: string;
  n: number;
}

export interface L2BookResponse {
  coin: string;
  levels: [L2BookLevel[], L2BookLevel[]]; // [bids, asks]
  time: number;
}

export interface RawTrade {
  coin: string;
  side: "B" | "A";
  px: string;
  sz: string;
  time: number;
  hash: string;
  liquidation: boolean;
}

export interface RawCandle {
  t: number; // open time
  T: number; // close time
  s: string; // coin
  i: string; // interval
  o: string; // open
  c: string; // close
  h: string; // high
  l: string; // low
  v: string; // volume
  n: number; // num trades
}

export interface AssetPosition {
  coin: string;
  szi: string; // signed size (negative = short)
  entryPx: string;
  positionValue: string;
  unrealizedPnl: string;
  returnOnEquity: string;
  liquidationPx: string | null;
  leverage: {
    type: "cross" | "isolated";
    value: number;
    rawUsd?: string;
  };
  maxTradeSzs?: [string, string];
  cumFunding?: {
    allTime: string;
    sinceOpen: string;
    sinceChange: string;
  };
}

export interface MarginSummary {
  accountValue: string;
  totalNtlPos: string;
  totalRawUsd: string;
  totalMarginUsed: string;
}

export interface ClearinghouseState {
  assetPositions: { position: AssetPosition }[];
  crossMarginSummary: MarginSummary;
  marginSummary: MarginSummary;
  withdrawable: string;
}

export interface OpenOrder {
  coin: string;
  limitPx: string;
  oid: number;
  side: "B" | "A";
  sz: string;
  timestamp: number;
  cloid?: string;
  orderType: string;
  origSz: string;
  reduceOnly: boolean;
}

export interface UserFill {
  coin: string;
  px: string;
  sz: string;
  side: "B" | "A";
  time: number;
  startPosition: string;
  dir: string;
  closedPnl: string;
  hash: string;
  oid: number;
  crossed: boolean;
  fee: string;
  liquidation: boolean;
}

export interface FundingEntry {
  coin: string;
  fundingRate: string;
  premium: string;
  time: number;
}

export interface PredictedFunding {
  coin: string;
  fundingRate: string;
  premium: string;
}

// ---------------------------------------------------------------------------
// Exchange API Types
// ---------------------------------------------------------------------------

export interface OrderWire {
  a: number; // asset index
  b: boolean; // isBuy
  p: string; // price
  s: string; // size
  r: boolean; // reduceOnly
  t:
    | { limit: { tif: "Gtc" | "Ioc" | "Alo" } }
    | {
        trigger: {
          isMarket: boolean;
          triggerPx: string;
          tpsl: "sl" | "tp";
        };
      };
  c?: string; // cloid (client order ID)
}

export interface PlaceOrderAction {
  type: "order";
  orders: OrderWire[];
  grouping: "na" | "normalTpsl" | "positionTpsl";
}

export interface CancelOrderAction {
  type: "cancel";
  cancels: { a: number; o: number }[];
}

export interface CancelByCloidAction {
  type: "cancelByCloid";
  cancels: { asset: number; cloid: string }[];
}

export interface BatchModifyAction {
  type: "batchModify";
  modifies: {
    oid: number;
    order: OrderWire;
  }[];
}

export interface UpdateLeverageAction {
  type: "updateLeverage";
  asset: number;
  isCross: boolean;
  leverage: number;
}

export type ExchangeAction =
  | PlaceOrderAction
  | CancelOrderAction
  | CancelByCloidAction
  | BatchModifyAction
  | UpdateLeverageAction;

export interface ExchangeRequest {
  action: ExchangeAction;
  nonce: number;
  signature: {
    r: string;
    s: string;
    v: number;
  };
  vaultAddress?: string;
}

export interface ExchangeResponseStatus {
  resting?: { oid: number };
  filled?: { totalSz: string; avgPx: string; oid: number };
  error?: string;
}

export interface ExchangeResponse {
  status: "ok" | "err";
  response?: {
    type: string;
    data?: {
      statuses: ExchangeResponseStatus[];
    };
  };
}

// ---------------------------------------------------------------------------
// WebSocket Types
// ---------------------------------------------------------------------------

export interface WsSubscription {
  type: "allMids" | "l2Book" | "trades" | "candle" | "orderUpdates" | "userFills";
  coin?: string;
  interval?: CandleInterval;
  user?: string;
}

export interface WsMessage {
  method: "subscribe" | "unsubscribe";
  subscription: WsSubscription;
}

export interface WsAllMidsData {
  mids: Record<string, string>;
}

export interface WsL2BookData {
  coin: string;
  levels: [[string, string][], [string, string][]];
  time: number;
}

export interface WsTradeData {
  coin: string;
  side: "B" | "A";
  px: string;
  sz: string;
  time: number;
  hash: string;
  liquidation: boolean;
}

export interface WsOrderUpdate {
  order: OpenOrder;
  status: "open" | "filled" | "canceled" | "triggered";
  statusTimestamp: number;
}

export interface WsChannelMessage {
  channel: string;
  data: unknown;
}

// ---------------------------------------------------------------------------
// High-level SDK types (used by order/position modules)
// ---------------------------------------------------------------------------

export interface PlaceOrderParams {
  coin: string;
  isBuy: boolean;
  price: number;
  size: number;
  reduceOnly?: boolean;
  orderType?: "limit" | "market";
  timeInForce?: "Gtc" | "Ioc" | "Alo";
  cloid?: string;
}

export interface PlaceTriggerOrderParams {
  coin: string;
  isBuy: boolean;
  size: number;
  triggerPrice: number;
  isMarket: boolean;
  tpsl: "sl" | "tp";
  reduceOnly?: boolean;
}

export interface CancelOrderParams {
  coin: string;
  orderId: number;
}

export interface ModifyOrderParams {
  orderId: number;
  coin: string;
  isBuy: boolean;
  price: number;
  size: number;
  reduceOnly?: boolean;
  orderType?: "limit" | "market";
  timeInForce?: "Gtc" | "Ioc" | "Alo";
}

export interface ClosePositionParams {
  coin: string;
  /** Size to close. If omitted, closes the entire position. */
  size?: number;
  /** Price for limit close. If omitted, closes at market. */
  price?: number;
}

/** Parsed position for external consumption */
export interface ParsedPosition {
  coin: string;
  side: "long" | "short";
  size: number;
  entryPrice: number;
  positionValue: number;
  unrealizedPnl: number;
  returnOnEquity: number;
  liquidationPrice: number | null;
  leverage: number;
  leverageType: "cross" | "isolated";
  marginUsed: number;
}

/** Parsed account info */
export interface AccountInfo {
  equity: number;
  totalPositionValue: number;
  totalRawUsd: number;
  totalMarginUsed: number;
  withdrawable: number;
  positions: ParsedPosition[];
}
