# Trading Strategies Specification

## Tenacitas Trading Floor -- Agent Skill System

Version: 1.0.0
Date: 2026-02-14
Status: Draft

---

## Table of Contents

1. [Skill System Architecture](#1-skill-system-architecture)
2. [Core Type Definitions](#2-core-type-definitions)
3. [Skill Lifecycle](#3-skill-lifecycle)
4. [Strategy 1: MomentumScalper](#4-strategy-1-momentumscalper)
5. [Strategy 2: SentimentAnalyzer](#5-strategy-2-sentimentanalyzer)
6. [Strategy 3: MeanReversion](#6-strategy-3-meanreversion)
7. [Strategy 4: BreakoutHunter](#7-strategy-4-breakouthunter)
8. [Strategy 5: GridTrader](#8-strategy-5-gridtrader)
9. [Risk Management Framework](#9-risk-management-framework)
10. [Hyperliquid Integration](#10-hyperliquid-integration)
11. [Signal Aggregation](#11-signal-aggregation)
12. [Backtesting Framework](#12-backtesting-framework)

---

## 1. Skill System Architecture

Each trading strategy is encapsulated as a **Skill** -- a self-contained, composable unit that receives market data, produces trade signals, validates them against risk constraints, and emits orders. Skills are pluggable: an agent can run one skill or compose many, with a signal aggregation layer resolving conflicts.

### Design Principles

- **Isolation**: Each skill manages its own state. No shared mutable state between skills.
- **Determinism**: Given the same `MarketData` input, a skill must produce the same `Signal` output (except SentimentAnalyzer which has an LLM component).
- **Fail-safe**: A skill that throws or times out produces no signal (treated as `NEUTRAL`). The system never enters a position on error.
- **Cloudflare Workers compatible**: No Node.js-specific APIs. Standard `fetch`, `WebSocket`, `crypto.subtle` only. No filesystem, no `Buffer`, no `node:` imports.
- **Sub-second hot path**: The `analyze -> signal -> riskCheck` pipeline must complete in <200ms for scalping strategies.

### Skill Registry

Skills are registered with the agent at startup. The agent's main loop iterates registered skills on each tick.

```typescript
interface SkillRegistry {
  register(skill: TradingSkill): void;
  unregister(skillId: string): void;
  getSkill(skillId: string): TradingSkill | undefined;
  listSkills(): TradingSkill[];
  getActiveSkills(): TradingSkill[]; // skills with enabled=true
}
```

---

## 2. Core Type Definitions

### 2.1 Enumerations

```typescript
type Side = "long" | "short";
type OrderType = "market" | "limit" | "stop_market" | "stop_limit" | "take_profit_market";
type OrderStatus = "pending" | "open" | "partial" | "filled" | "cancelled" | "rejected";
type SignalDirection = "long" | "short" | "close_long" | "close_short" | "neutral";
type Timeframe = "5s" | "15s" | "30s" | "1m" | "3m" | "5m" | "15m" | "1h" | "4h" | "1d";
type SkillStatus = "initializing" | "running" | "paused" | "stopped" | "error";
```

### 2.2 MarketData

```typescript
interface Candle {
  timestamp: number;      // Unix ms
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;         // Base asset volume
  numTrades: number;
}

interface OrderBookLevel {
  price: number;
  size: number;           // Base asset
  numOrders: number;
}

interface OrderBook {
  timestamp: number;
  bids: OrderBookLevel[]; // Sorted descending by price
  asks: OrderBookLevel[]; // Sorted ascending by price
  midPrice: number;
  spread: number;
  spreadBps: number;      // Spread in basis points
}

interface Trade {
  timestamp: number;
  price: number;
  size: number;
  side: Side;
  liquidation: boolean;   // Whether this trade was a liquidation
}

interface FundingRate {
  asset: string;
  rate: number;           // Current hourly funding rate (e.g., 0.0001 = 0.01%)
  nextFundingTime: number;
  predictedRate: number;
  premium: number;        // Basis between mark and index
}

interface MarketData {
  asset: string;           // e.g., "ETH", "BTC"
  timestamp: number;

  // Price feeds
  markPrice: number;
  indexPrice: number;
  lastTradePrice: number;

  // OHLCV candles per timeframe
  candles: Map<Timeframe, Candle[]>;

  // Order book snapshot
  orderBook: OrderBook;

  // Recent trades (last N seconds)
  recentTrades: Trade[];

  // Funding
  funding: FundingRate;

  // Open interest
  openInterest: number;
  openInterestDelta24h: number; // Change in OI over 24h

  // Derived (pre-computed by data layer)
  volumeDelta: number;         // Buy volume - sell volume over lookback window
  cvd: number;                 // Cumulative volume delta
  vwap: number;                // Volume-weighted average price
}
```

### 2.3 Signal

```typescript
interface Signal {
  skillId: string;
  asset: string;
  timestamp: number;
  direction: SignalDirection;
  confidence: number;          // 0.0 to 1.0
  strength: number;            // 0.0 to 1.0 (magnitude of conviction)

  // Suggested execution parameters
  suggestedEntry: number;      // Price
  suggestedStopLoss: number;
  suggestedTakeProfit: number[];  // Multiple TP levels
  suggestedSize: number;       // In base asset units
  suggestedLeverage: number;
  suggestedOrderType: OrderType;
  timeInForce: "GTC" | "IOC" | "FOK";
  maxSlippageBps: number;      // Max acceptable slippage in bps

  // Context
  reasoning: string;           // Human-readable explanation
  indicators: Record<string, number>; // Key indicator values at signal time
  metadata: Record<string, unknown>;
}
```

### 2.4 Order

```typescript
interface Order {
  id: string;                  // Internal order ID
  exchangeOrderId?: string;    // Hyperliquid order ID (set after submission)
  skillId: string;
  asset: string;
  side: Side;
  orderType: OrderType;
  price: number;               // Limit price (0 for market)
  size: number;                // Base asset units
  leverage: number;
  reduceOnly: boolean;
  timeInForce: "GTC" | "IOC" | "FOK";

  // Status tracking
  status: OrderStatus;
  filledSize: number;
  avgFillPrice: number;
  fees: number;
  createdAt: number;
  updatedAt: number;

  // Link to parent signal
  signalId: string;

  // Attached conditional orders
  stopLoss?: {
    triggerPrice: number;
    orderType: "stop_market" | "stop_limit";
    limitPrice?: number;
  };
  takeProfit?: {
    triggerPrice: number;
    orderType: "take_profit_market";
  }[];
}
```

### 2.5 Position

```typescript
interface Position {
  asset: string;
  side: Side;
  size: number;                // Current size in base asset
  entryPrice: number;          // Average entry price
  markPrice: number;           // Current mark price
  liquidationPrice: number;
  leverage: number;
  margin: number;              // USDC margin allocated
  unrealizedPnl: number;
  realizedPnl: number;
  fundingPayments: number;     // Cumulative funding received/paid
  maxDrawdown: number;         // Worst unrealized PnL since entry
  openedAt: number;
  lastUpdatedAt: number;

  // Linked orders
  activeOrders: Order[];
  skillId: string;             // Which skill owns this position
}
```

### 2.6 Portfolio

```typescript
interface Portfolio {
  totalEquity: number;         // Total account value in USDC
  availableMargin: number;     // Free margin
  usedMargin: number;          // Margin in use
  maintenanceMargin: number;
  totalUnrealizedPnl: number;
  totalRealizedPnl: number;
  leverage: number;            // Account-level leverage

  positions: Position[];
  openOrders: Order[];

  // Risk metrics
  totalExposure: number;       // Sum of |position notional|
  exposureRatio: number;       // totalExposure / totalEquity
  maxDrawdownSession: number;  // Worst drawdown this session
  sharpeEstimate: number;      // Rolling Sharpe (if enough data)
  winRate: number;             // Wins / total closed trades
  profitFactor: number;        // Gross profit / gross loss
}
```

### 2.7 TradingSkill Interface

```typescript
interface SkillConfig {
  id: string;
  name: string;
  version: string;
  description: string;
  author: string;
  enabled: boolean;

  // Which assets this skill trades
  assets: string[];

  // Timeframes this skill needs
  requiredTimeframes: Timeframe[];

  // Data requirements
  requiredCandleHistory: number;    // Number of candles per timeframe
  requiresOrderBook: boolean;
  requiresRecentTrades: boolean;
  requiresFunding: boolean;

  // Execution
  tickIntervalMs: number;           // How often to call analyze()
  maxConcurrentPositions: number;   // Per asset

  // Risk parameters (per-skill)
  risk: SkillRiskConfig;

  // Strategy-specific parameters
  params: Record<string, unknown>;
}

interface SkillRiskConfig {
  maxPositionSizePct: number;       // Max % of portfolio per position
  maxTotalExposurePct: number;      // Max % of portfolio across all positions
  maxLeverage: number;
  stopLossPct: number;              // Default stop loss %
  maxDailyLossPct: number;          // Max daily loss before auto-pause
  maxDrawdownPct: number;           // Max drawdown before auto-stop
  maxTradesPerHour: number;         // Rate limit
  maxOpenPositions: number;
  cooldownAfterLossMs: number;      // Wait period after a losing trade
}

interface SkillState {
  status: SkillStatus;
  lastTickAt: number;
  lastSignalAt: number;
  lastTradeAt: number;
  tradeCount: number;
  winCount: number;
  lossCount: number;
  totalPnl: number;
  dailyPnl: number;
  maxDrawdown: number;
  consecutiveLosses: number;
  customState: Record<string, unknown>; // Skill-specific state
}

interface TradingSkill {
  readonly config: SkillConfig;
  state: SkillState;

  /**
   * Called once when the skill is registered.
   * Use for pre-computing indicator lookback buffers, warming up state, etc.
   */
  initialize(portfolio: Portfolio, historicalData: Map<string, MarketData[]>): Promise<void>;

  /**
   * Called on each tick. Analyzes market data and produces a signal.
   * Must complete within tickIntervalMs / 2.
   */
  analyze(marketData: Map<string, MarketData>, portfolio: Portfolio): Promise<Signal | null>;

  /**
   * Validates a signal against the skill's own risk constraints.
   * Returns the signal (possibly modified) or null to reject.
   */
  riskCheck(signal: Signal, portfolio: Portfolio): Promise<Signal | null>;

  /**
   * Translates a validated signal into concrete orders.
   */
  createOrders(signal: Signal, portfolio: Portfolio): Promise<Order[]>;

  /**
   * Called when an order fill is received. Update internal state.
   */
  onFill(order: Order, position: Position): Promise<void>;

  /**
   * Called when a position is closed. Update internal state, log results.
   */
  onPositionClose(position: Position, reason: string): Promise<void>;

  /**
   * Graceful shutdown. Cancel open orders, optionally close positions.
   */
  shutdown(reason: string): Promise<void>;
}
```

### 2.8 Execution Log

```typescript
interface TradeLog {
  id: string;
  skillId: string;
  asset: string;
  side: Side;
  entryPrice: number;
  exitPrice: number;
  size: number;
  leverage: number;
  pnl: number;
  pnlPct: number;
  fees: number;
  fundingPaid: number;
  durationMs: number;
  entrySignal: Signal;
  exitReason: string;       // "take_profit" | "stop_loss" | "trailing_stop" | "signal_reversal" | "risk_limit" | "manual" | "kill_switch"
  slippage: number;         // Entry slippage in bps
  timestamp: number;
}
```

---

## 3. Skill Lifecycle

```
                    +------------+
                    | REGISTERED |
                    +-----+------+
                          |
                    initialize()
                          |
                    +-----v------+
               +--->|  RUNNING   |<---+
               |    +-----+------+    |
               |          |           |
               |    analyze(tick)     |
               |          |           |
               |    +-----v------+   |
               |    |   SIGNAL   |   |
               |    +-----+------+   |
               |          |          |
               |    riskCheck()      |
               |          |          |
               |   pass?  |  fail?---+  (back to running, no action)
               |          |
               |    +-----v-------+
               |    | createOrders |
               |    +-----+-------+
               |          |
               |    submit to exchange
               |          |
               |    +-----v------+
               |    |   onFill   |
               |    +-----+------+
               |          |
               |    position open
               |          |
               |    +-----v----------+
               +----| onPositionClose|
                    +----------------+
```

### Tick Loop (per skill)

```
Every skill.config.tickIntervalMs:
  1. Fetch latest MarketData for skill.config.assets
  2. Call skill.analyze(marketData, portfolio)
  3. If signal is non-null and direction != "neutral":
     a. Call skill.riskCheck(signal, portfolio)
     b. If risk check passes:
        - Call global RiskManager.validate(signal, portfolio)
        - If global risk passes:
          i.  Call skill.createOrders(signal, portfolio)
          ii. Submit orders via HyperliquidClient
          iii. Log signal + orders
     c. If risk check fails: log rejection reason
  4. Update skill.state
```

---

## 4. Strategy 1: MomentumScalper

### Overview

High-frequency momentum strategy targeting sub-minute price moves on Hyperliquid PERPS. Uses EMA crossovers as the primary signal, confirmed by volume delta and order flow imbalance. Designed for liquid pairs (BTC, ETH, SOL) where tight spreads allow profitable scalping.

### Configuration

```typescript
const MomentumScalperConfig: SkillConfig = {
  id: "momentum-scalper",
  name: "Momentum Scalper",
  version: "1.0.0",
  description: "Sub-minute EMA crossover scalper with volume delta confirmation",
  author: "tenacitas",
  enabled: true,
  assets: ["BTC", "ETH", "SOL"],
  requiredTimeframes: ["5s", "15s", "1m"],
  requiredCandleHistory: 100,        // 100 candles per timeframe
  requiresOrderBook: true,
  requiresRecentTrades: true,
  requiresFunding: false,
  tickIntervalMs: 1000,              // Tick every 1 second
  maxConcurrentPositions: 1,         // One position per asset at a time
  risk: {
    maxPositionSizePct: 5,           // Max 5% of portfolio per position
    maxTotalExposurePct: 15,         // Max 15% across all MomentumScalper positions
    maxLeverage: 10,
    stopLossPct: 0.3,               // 0.3% stop loss (tight for scalping)
    maxDailyLossPct: 2,             // Stop trading after 2% daily loss
    maxDrawdownPct: 5,              // Hard stop at 5% drawdown
    maxTradesPerHour: 30,           // Max 30 trades/hour to limit fees
    maxOpenPositions: 3,            // Max 3 simultaneous positions (across assets)
    cooldownAfterLossMs: 10_000,    // 10 second cooldown after a loss
  },
  params: {
    emaFastPeriod: 9,
    emaSlowPeriod: 21,
    volumeDeltaThreshold: 1.5,       // Volume delta must be 1.5x average
    minSpreadBps: 1,                 // Skip if spread > 1 bps (too wide)
    maxSpreadBps: 5,
    atrPeriod: 14,
    atrStopMultiplier: 1.5,          // Stop loss at 1.5x ATR
    atrTpMultiplier: 2.0,            // Take profit at 2x ATR
    minConfidence: 0.6,
    orderBookImbalanceThreshold: 0.6, // Bid/ask ratio threshold
    trailingStopActivationPct: 0.15,  // Activate trailing stop at 0.15% profit
    trailingStopDistancePct: 0.1,     // Trail by 0.1%
  },
};
```

### Indicators

| Indicator | Parameters | Purpose |
|-----------|-----------|---------|
| EMA(9) | 9-period on 15s candles | Fast momentum line |
| EMA(21) | 21-period on 15s candles | Slow momentum line |
| ATR(14) | 14-period on 1m candles | Volatility for sizing and stops |
| Volume Delta | Buy vol - sell vol, 30s window | Confirms directional pressure |
| Order Book Imbalance | Top 5 levels bid/ask ratio | Confirms immediate supply/demand |
| CVD | Cumulative volume delta | Trend confirmation |

### Entry Logic

```
function analyzeForEntry(data: MarketData):
  candles_15s = data.candles.get("15s")
  candles_1m  = data.candles.get("1m")

  ema_fast = EMA(candles_15s.close, 9)
  ema_slow = EMA(candles_15s.close, 21)
  atr      = ATR(candles_1m, 14)

  prev_ema_fast = ema_fast[-2]
  prev_ema_slow = ema_slow[-2]
  curr_ema_fast = ema_fast[-1]
  curr_ema_slow = ema_slow[-1]

  // Detect crossover
  bullish_cross = prev_ema_fast <= prev_ema_slow AND curr_ema_fast > curr_ema_slow
  bearish_cross = prev_ema_fast >= prev_ema_slow AND curr_ema_fast < curr_ema_slow

  if not (bullish_cross or bearish_cross):
    return null

  // Confirm with volume delta
  vol_delta = data.volumeDelta
  avg_vol_delta = mean(abs(recent_volume_deltas), 20)

  if bullish_cross:
    if vol_delta < avg_vol_delta * params.volumeDeltaThreshold:
      return null  // Not enough buying pressure
    if data.orderBook.bidVolume / data.orderBook.askVolume < params.orderBookImbalanceThreshold:
      return null  // Order book doesn't confirm

  if bearish_cross:
    if -vol_delta < avg_vol_delta * params.volumeDeltaThreshold:
      return null  // Not enough selling pressure
    if data.orderBook.askVolume / data.orderBook.bidVolume < params.orderBookImbalanceThreshold:
      return null  // Order book doesn't confirm

  // Calculate confidence
  ema_separation = abs(curr_ema_fast - curr_ema_slow) / curr_ema_slow
  vol_strength = abs(vol_delta) / avg_vol_delta
  confidence = clamp(0.5 + ema_separation * 100 + (vol_strength - 1) * 0.2, 0, 1)

  if confidence < params.minConfidence:
    return null

  // Position sizing via ATR
  stop_distance = atr[-1] * params.atrStopMultiplier
  tp_distance   = atr[-1] * params.atrTpMultiplier

  direction = bullish_cross ? "long" : "short"
  entry = data.markPrice
  stop  = direction == "long" ? entry - stop_distance : entry + stop_distance
  tp    = direction == "long" ? entry + tp_distance   : entry - tp_distance

  return Signal {
    direction,
    confidence,
    suggestedEntry: entry,
    suggestedStopLoss: stop,
    suggestedTakeProfit: [tp],
    suggestedOrderType: "market",
    timeInForce: "IOC",
    maxSlippageBps: 3,
  }
```

### Exit Logic

```
function analyzeForExit(data: MarketData, position: Position):
  candles_15s = data.candles.get("15s")
  ema_fast = EMA(candles_15s.close, 9)
  ema_slow = EMA(candles_15s.close, 21)

  // Exit on reverse crossover
  if position.side == "long":
    if ema_fast[-1] < ema_slow[-1]:
      return Signal { direction: "close_long", reasoning: "EMA bearish crossover" }

  if position.side == "short":
    if ema_fast[-1] > ema_slow[-1]:
      return Signal { direction: "close_short", reasoning: "EMA bullish crossover" }

  // Trailing stop (managed by exchange SL order, but also checked here)
  pnl_pct = position.unrealizedPnl / position.margin
  if pnl_pct >= params.trailingStopActivationPct:
    new_stop = position.side == "long"
      ? data.markPrice * (1 - params.trailingStopDistancePct / 100)
      : data.markPrice * (1 + params.trailingStopDistancePct / 100)
    // Update stop loss order on exchange
    updateStopLoss(position, new_stop)

  return null  // Hold position
```

### Edge Cases and Failure Modes

| Scenario | Handling |
|----------|----------|
| Whipsaw (rapid cross/uncross) | Cooldown timer prevents re-entry for 10s after exit. Minimum EMA separation required. |
| Low liquidity / wide spread | Skip signal if `spreadBps > maxSpreadBps`. Check order book depth before sizing. |
| Exchange latency spike | IOC orders auto-cancel if not filled. Max slippage guard at 3 bps. |
| Rapid consecutive losses | After 3 consecutive losses, double the cooldown. After 5, pause skill for 5 minutes. |
| Funding rate adverse | Not a concern for scalping (sub-minute holds), but monitor funding window proximity. |
| Flash crash / cascade liquidation | ATR-based stop loss provides protection. Kill switch triggers at portfolio-level drawdown. |

### Backtesting Approach

- **Data**: 15-second candles + trade-level data from Hyperliquid historical API
- **Period**: Minimum 30 days, ideally 90 days covering different regimes (trending, ranging, volatile)
- **Execution model**: Market orders with 2 bps simulated slippage + 0.035% taker fee
- **Metrics**: Sharpe ratio, win rate, profit factor, max drawdown, avg trade duration, trades per day
- **Walk-forward**: 70% in-sample / 30% out-of-sample, rolling 7-day windows
- **Regime filter**: Separate metrics for high/low volatility periods (ATR percentile)

---

## 5. Strategy 2: SentimentAnalyzer

### Overview

Uses Claude as an LLM to analyze market sentiment from news, social media, and on-chain data. Produces a directional bias that is then confirmed by technical indicators before generating a trade signal. This is a slower-frequency strategy (minutes to hours) that captures narrative-driven moves.

### Configuration

```typescript
const SentimentAnalyzerConfig: SkillConfig = {
  id: "sentiment-analyzer",
  name: "Sentiment Analyzer",
  version: "1.0.0",
  description: "Claude-powered sentiment analysis with technical confirmation",
  author: "tenacitas",
  enabled: true,
  assets: ["BTC", "ETH", "SOL", "DOGE", "PEPE", "WIF"],
  requiredTimeframes: ["5m", "15m", "1h"],
  requiredCandleHistory: 50,
  requiresOrderBook: false,
  requiresRecentTrades: false,
  requiresFunding: true,
  tickIntervalMs: 60_000,            // Analyze every 60 seconds
  maxConcurrentPositions: 1,
  risk: {
    maxPositionSizePct: 3,
    maxTotalExposurePct: 10,
    maxLeverage: 5,
    stopLossPct: 2,
    maxDailyLossPct: 3,
    maxDrawdownPct: 8,
    maxTradesPerHour: 4,
    maxOpenPositions: 3,
    cooldownAfterLossMs: 300_000,     // 5 minutes after a loss
  },
  params: {
    sentimentSources: ["news_api", "twitter_api", "onchain_whale_alerts"],
    claudeModel: "claude-sonnet-4-5-20250929",  // Fast model for sentiment
    sentimentCacheTtlMs: 120_000,     // Cache sentiment for 2 minutes
    minSentimentScore: 0.65,          // Min |sentiment| to act
    technicalConfirmation: true,
    rsiPeriod: 14,
    rsiOverbought: 70,
    rsiOversold: 30,
    macdFastPeriod: 12,
    macdSlowPeriod: 26,
    macdSignalPeriod: 9,
    minConfidence: 0.55,
    positionHoldMaxMs: 14_400_000,    // Max 4 hours per position
  },
};
```

### Sentiment Analysis Pipeline

```
function analyzeSentiment(asset: string):
  // 1. Gather raw data from multiple sources
  sources = []

  // News API
  news = await fetchNews(asset, last_2_hours)
  sources.push(...news.map(n => { type: "news", text: n.title + " " + n.summary, source: n.source, timestamp: n.publishedAt }))

  // Twitter/X API
  tweets = await fetchTweets(asset, last_1_hour, minFollowers=10000)
  sources.push(...tweets.map(t => { type: "tweet", text: t.text, source: t.username, followers: t.followers, timestamp: t.createdAt }))

  // On-chain whale alerts
  whaleMovements = await fetchWhaleAlerts(asset, last_1_hour)
  sources.push(...whaleMovements.map(w => { type: "onchain", text: formatWhaleAlert(w), source: "chain", timestamp: w.timestamp }))

  if sources.length == 0:
    return { score: 0, confidence: 0, reasoning: "No data" }

  // 2. Prompt Claude for sentiment analysis
  prompt = buildSentimentPrompt(asset, sources)

  response = await claude.messages.create({
    model: params.claudeModel,
    max_tokens: 500,
    system: SENTIMENT_SYSTEM_PROMPT,
    messages: [{ role: "user", content: prompt }],
  })

  // 3. Parse structured response
  // Claude returns JSON: { score: -1.0 to 1.0, confidence: 0 to 1, catalysts: [...], reasoning: "..." }
  sentiment = parseClaudeResponse(response)

  return sentiment
```

### Sentiment System Prompt

```
You are a quantitative sentiment analyzer for crypto perpetual futures trading.
Given market data sources, output a JSON object with:
- score: float from -1.0 (extremely bearish) to 1.0 (extremely bullish)
- confidence: float from 0 to 1 (how confident you are in the sentiment reading)
- catalysts: array of strings describing key drivers
- reasoning: one-sentence explanation

Rules:
- Weight institutional/whale activity higher than retail sentiment
- Distinguish between realized events and speculation
- Consider contrarian signals (extreme sentiment often precedes reversals)
- Score 0 means genuinely neutral, not uncertain -- use low confidence for uncertainty
- Be skeptical of coordinated social media campaigns
- Consider the source credibility (major outlets > anonymous accounts)

Output ONLY valid JSON. No explanation outside the JSON.
```

### Entry Logic

```
function analyzeForEntry(data: MarketData):
  // 1. Get sentiment (cached for sentimentCacheTtlMs)
  sentiment = await getCachedSentiment(data.asset)
  if abs(sentiment.score) < params.minSentimentScore:
    return null

  // 2. Technical confirmation
  if params.technicalConfirmation:
    candles_15m = data.candles.get("15m")
    rsi = RSI(candles_15m.close, params.rsiPeriod)
    macd = MACD(candles_15m.close, params.macdFastPeriod, params.macdSlowPeriod, params.macdSignalPeriod)

    if sentiment.score > 0:  // Bullish sentiment
      // Confirm: RSI not overbought AND MACD histogram positive or crossing up
      if rsi[-1] > params.rsiOverbought:
        return null  // Overbought, don't chase
      if macd.histogram[-1] < 0 AND macd.histogram[-2] < 0:
        return null  // MACD not confirming

    if sentiment.score < 0:  // Bearish sentiment
      if rsi[-1] < params.rsiOversold:
        return null  // Oversold, don't short the bottom
      if macd.histogram[-1] > 0 AND macd.histogram[-2] > 0:
        return null  // MACD not confirming

  // 3. Build signal
  direction = sentiment.score > 0 ? "long" : "short"
  confidence = sentiment.confidence * 0.6 + technicalConfirmationStrength * 0.4

  if confidence < params.minConfidence:
    return null

  atr = ATR(data.candles.get("1h"), 14)
  stop_distance = atr[-1] * 2.5
  tp_distance   = atr[-1] * 4.0

  entry = data.markPrice
  stop  = direction == "long" ? entry - stop_distance : entry + stop_distance
  tp    = direction == "long" ? entry + tp_distance   : entry - tp_distance

  return Signal {
    direction,
    confidence,
    suggestedEntry: entry,
    suggestedStopLoss: stop,
    suggestedTakeProfit: [tp * 0.5, tp],  // Partial TP at 50%, full TP at 100%
    suggestedOrderType: "limit",
    suggestedSize: calculatePositionSize(portfolio, confidence, atr[-1]),
    maxSlippageBps: 10,
    reasoning: sentiment.reasoning,
    metadata: { sentiment_score: sentiment.score, catalysts: sentiment.catalysts },
  }
```

### Exit Logic

```
function analyzeForExit(data: MarketData, position: Position):
  // 1. Time-based exit
  holdDuration = Date.now() - position.openedAt
  if holdDuration > params.positionHoldMaxMs:
    return Signal { direction: closeDirection(position), reasoning: "Max hold time reached" }

  // 2. Sentiment reversal
  sentiment = await getCachedSentiment(data.asset)
  if position.side == "long" AND sentiment.score < -0.3:
    return Signal { direction: "close_long", reasoning: "Sentiment reversed bearish" }
  if position.side == "short" AND sentiment.score > 0.3:
    return Signal { direction: "close_short", reasoning: "Sentiment reversed bullish" }

  // 3. Technical exit (RSI extreme)
  rsi = RSI(data.candles.get("15m").close, params.rsiPeriod)
  if position.side == "long" AND rsi[-1] > 80:
    return Signal { direction: "close_long", reasoning: "RSI overbought exit" }
  if position.side == "short" AND rsi[-1] < 20:
    return Signal { direction: "close_short", reasoning: "RSI oversold exit" }

  return null
```

### Edge Cases and Failure Modes

| Scenario | Handling |
|----------|----------|
| Claude API timeout/error | Return neutral signal. Cache last valid sentiment for up to 10 minutes. |
| Coordinated FUD/shill campaigns | Claude prompt instructs skepticism. Weight credible sources higher. Require technical confirmation. |
| Conflicting sources | Claude weighs and resolves. Low confidence score if genuinely mixed. |
| Stale sentiment data | TTL-based cache invalidation. Force refresh if position is open. |
| LLM hallucination | Structured JSON output with validation. Reject malformed responses. |
| News lag (event already priced in) | Technical confirmation prevents chasing. RSI overbought/oversold filter. |
| Rate limits on news/social APIs | Exponential backoff. Degrade gracefully (fewer sources, not zero). |

### Backtesting Approach

- **Data**: Historical news + tweet archives + price data with timestamps
- **LLM backtesting**: Pre-compute Claude sentiment scores on historical data, store as time series
- **Caution**: LLM backtesting has look-ahead bias risk (model trained on data that includes outcomes). Mitigate by using only data available at the timestamp.
- **Metrics**: Focus on hit rate of directional calls, average R:R, max consecutive losses
- **Forward test**: Paper trade for 2 weeks minimum before live deployment

---

## 6. Strategy 3: MeanReversion

### Overview

Statistical arbitrage strategy exploiting mean-reverting behavior of perpetual futures funding rates on Hyperliquid. When the funding rate deviates significantly (>2 standard deviations) from its historical mean, the strategy takes a position expecting the rate to normalize. This is a market-neutral approach when combined with spot hedging, or a directional bet on funding rate normalization.

### Configuration

```typescript
const MeanReversionConfig: SkillConfig = {
  id: "mean-reversion",
  name: "Mean Reversion (Funding Rate Arb)",
  version: "1.0.0",
  description: "Funding rate statistical arbitrage - enter when funding deviates >2sigma from mean",
  author: "tenacitas",
  enabled: true,
  assets: ["BTC", "ETH", "SOL", "DOGE", "ARB", "OP", "AVAX", "MATIC"],
  requiredTimeframes: ["1h", "4h"],
  requiredCandleHistory: 200,        // Need long history for statistical measures
  requiresOrderBook: true,
  requiresRecentTrades: false,
  requiresFunding: true,             // Critical for this strategy
  tickIntervalMs: 30_000,            // Check every 30 seconds
  maxConcurrentPositions: 1,
  risk: {
    maxPositionSizePct: 8,           // Can be larger since funding arb is lower risk
    maxTotalExposurePct: 30,         // Higher total exposure allowed for arb
    maxLeverage: 3,                  // Low leverage for safety
    stopLossPct: 1.5,               // Wider stop (funding positions are slower)
    maxDailyLossPct: 2,
    maxDrawdownPct: 6,
    maxTradesPerHour: 4,
    maxOpenPositions: 5,             // Multiple pairs at once
    cooldownAfterLossMs: 600_000,    // 10 minutes after loss
  },
  params: {
    fundingLookbackHours: 168,        // 7 days of funding history
    fundingZScoreThreshold: 2.0,      // Enter when |z-score| > 2
    fundingZScoreExitThreshold: 0.5,  // Exit when |z-score| < 0.5
    minFundingRate: 0.0005,           // Min absolute funding rate to bother (0.05%)
    maxFundingRate: 0.05,             // Max funding rate -- beyond this, something unusual
    positionSizeMethod: "kelly",      // "fixed" | "kelly" | "atr"
    kellyFraction: 0.25,             // Quarter Kelly for safety
    maxHoldHours: 72,                // Max 3 days per position
    reentryWaitHours: 4,             // Wait 4 hours before re-entering same asset
    minConfidence: 0.6,
    useDeltaNeutral: false,          // If true, hedge with spot (requires spot balance)
  },
};
```

### Indicators

| Indicator | Parameters | Purpose |
|-----------|-----------|---------|
| Funding Rate | Current hourly rate | Primary signal source |
| Funding Mean | 168-hour rolling mean | Baseline for mean reversion |
| Funding StdDev | 168-hour rolling stddev | Defines deviation bands |
| Z-Score | (current - mean) / stddev | Signal trigger |
| Open Interest | Current + 24h delta | Confirms crowded trade |
| Predicted Funding | Next period estimate | Direction confirmation |

### Entry Logic

```
function analyzeForEntry(data: MarketData):
  funding = data.funding
  historicalFunding = getHistoricalFunding(data.asset, params.fundingLookbackHours)

  if historicalFunding.length < 24:  // Need minimum history
    return null

  mean   = mean(historicalFunding)
  stddev = stddev(historicalFunding)

  if stddev == 0:
    return null  // No variance, skip

  zScore = (funding.rate - mean) / stddev

  // Check if funding is extreme enough
  if abs(zScore) < params.fundingZScoreThreshold:
    return null

  // Sanity check on absolute rate
  if abs(funding.rate) < params.minFundingRate:
    return null
  if abs(funding.rate) > params.maxFundingRate:
    return null  // Anomalous, don't touch

  // Determine direction
  // High positive funding = longs paying shorts = too many longs = go SHORT
  // High negative funding = shorts paying longs = too many shorts = go LONG
  if zScore > params.fundingZScoreThreshold:
    direction = "short"  // Funding is extremely positive, expect reversion down
  elif zScore < -params.fundingZScoreThreshold:
    direction = "long"   // Funding is extremely negative, expect reversion up

  // Confirm with open interest (crowded trade confirmation)
  oiConfirmation = data.openInterestDelta24h > 0  // Rising OI confirms crowding
  if not oiConfirmation:
    // Still proceed but lower confidence
    pass

  // Calculate confidence based on z-score magnitude
  confidence = clamp(abs(zScore) / 4.0, 0.5, 0.95)
  if oiConfirmation:
    confidence = min(confidence + 0.1, 0.95)

  if confidence < params.minConfidence:
    return null

  // Position sizing (Kelly criterion)
  if params.positionSizeMethod == "kelly":
    // Estimated win rate from historical funding reversion
    winRate = calculateHistoricalReversionWinRate(historicalFunding, params.fundingZScoreThreshold)
    avgWin = calculateAvgWin(historicalFunding)
    avgLoss = calculateAvgLoss(historicalFunding)

    kellyPct = (winRate * avgWin - (1 - winRate) * avgLoss) / avgWin
    kellyPct = max(kellyPct, 0) * params.kellyFraction  // Quarter Kelly
    sizePct = min(kellyPct, params.risk.maxPositionSizePct / 100)
  else:
    sizePct = params.risk.maxPositionSizePct / 100

  atr = ATR(data.candles.get("4h"), 14)
  stop_distance = atr[-1] * 3.0   // Wide stop for funding arb
  tp_distance   = atr[-1] * 2.0   // Tighter TP (we profit from funding + reversion)

  entry = data.markPrice
  stop  = direction == "long" ? entry - stop_distance : entry + stop_distance
  tp    = direction == "long" ? entry + tp_distance   : entry - tp_distance

  return Signal {
    direction,
    confidence,
    suggestedEntry: entry,
    suggestedStopLoss: stop,
    suggestedTakeProfit: [tp],
    suggestedOrderType: "limit",     // Limit order to capture maker rebate
    suggestedSize: portfolio.totalEquity * sizePct / entry,
    suggestedLeverage: min(params.risk.maxLeverage, 3),
    maxSlippageBps: 5,
    reasoning: `Funding rate z-score: ${zScore.toFixed(2)}, rate: ${(funding.rate * 100).toFixed(4)}%, mean: ${(mean * 100).toFixed(4)}%`,
    indicators: { zScore, fundingRate: funding.rate, fundingMean: mean, fundingStddev: stddev },
  }
```

### Exit Logic

```
function analyzeForExit(data: MarketData, position: Position):
  funding = data.funding
  historicalFunding = getHistoricalFunding(data.asset, params.fundingLookbackHours)
  mean   = mean(historicalFunding)
  stddev = stddev(historicalFunding)
  zScore = (funding.rate - mean) / stddev

  // 1. Mean reversion complete (z-score returned to normal)
  if abs(zScore) < params.fundingZScoreExitThreshold:
    return Signal { direction: closeDirection(position), reasoning: `Funding normalized, z-score: ${zScore.toFixed(2)}` }

  // 2. Funding reversed beyond our position
  if position.side == "short" AND zScore < -params.fundingZScoreThreshold:
    return Signal { direction: "close_short", reasoning: "Funding overshot to negative" }
  if position.side == "long" AND zScore > params.fundingZScoreThreshold:
    return Signal { direction: "close_long", reasoning: "Funding overshot to positive" }

  // 3. Max hold time
  holdHours = (Date.now() - position.openedAt) / 3_600_000
  if holdHours > params.maxHoldHours:
    return Signal { direction: closeDirection(position), reasoning: "Max hold time reached" }

  return null
```

### Edge Cases and Failure Modes

| Scenario | Handling |
|----------|----------|
| Funding stays extreme (trending market) | Max hold time limits exposure. Stop loss prevents catastrophic loss. |
| Funding rate manipulation | Max funding rate filter (>5% is anomalous). Cross-reference with OI changes. |
| Liquidation cascade | Stop loss and position sizing limit impact. Max leverage of 3x is conservative. |
| Funding window timing | Don't enter within 30 min of funding settlement (rate is already known). |
| Low liquidity pair | Check order book depth before entry. Skip if bid-ask spread > 10 bps. |
| Multiple correlated entries | Portfolio-level correlation check prevents entering BTC + ETH + SOL all on same signal. |

### Backtesting Approach

- **Data**: Historical funding rates (Hyperliquid provides 8h settlement data, reconstruct hourly from predicted rates)
- **Period**: 6+ months to capture multiple market regimes
- **Key metric**: Funding income vs. directional P&L (strategy should profit from both in good entries)
- **Slippage model**: Limit orders with partial fill simulation
- **Comparison**: Benchmark against simple "short when funding positive" strategy
- **Monte Carlo**: Randomize entry timing within z-score bands to test robustness

---

## 7. Strategy 4: BreakoutHunter

### Overview

Identifies consolidation periods using Bollinger Band squeeze detection, then enters on volume-confirmed breakouts. Uses ATR-based trailing stops to ride the trend. Works best on mid-cap assets where breakouts tend to produce sustained directional moves.

### Configuration

```typescript
const BreakoutHunterConfig: SkillConfig = {
  id: "breakout-hunter",
  name: "Breakout Hunter",
  version: "1.0.0",
  description: "Bollinger squeeze detection with volume-confirmed breakout entries",
  author: "tenacitas",
  enabled: true,
  assets: ["ETH", "SOL", "AVAX", "ARB", "OP", "SUI", "APT"],
  requiredTimeframes: ["5m", "15m", "1h"],
  requiredCandleHistory: 100,
  requiresOrderBook: true,
  requiresRecentTrades: true,
  requiresFunding: false,
  tickIntervalMs: 5_000,             // Check every 5 seconds during squeeze
  maxConcurrentPositions: 1,
  risk: {
    maxPositionSizePct: 5,
    maxTotalExposurePct: 15,
    maxLeverage: 7,
    stopLossPct: 1.0,
    maxDailyLossPct: 3,
    maxDrawdownPct: 7,
    maxTradesPerHour: 6,
    maxOpenPositions: 3,
    cooldownAfterLossMs: 60_000,      // 1 minute after a loss
  },
  params: {
    bbPeriod: 20,
    bbStdDev: 2.0,
    squeezeLookback: 10,              // Look at last 10 BB widths
    squeezePercentile: 20,            // Squeeze = BB width in bottom 20th percentile
    minSqueezeCandles: 5,             // Minimum candles in squeeze before breakout
    volumeConfirmationMultiple: 2.0,  // Breakout candle volume must be 2x average
    atrPeriod: 14,
    atrTrailingStopMultiplier: 2.0,
    atrTakeProfitMultiplier: 3.0,
    falseBreakoutFilter: true,
    falseBreakoutRetestCandles: 3,    // Wait 3 candles after break to confirm
    minConfidence: 0.6,
    keltnerPeriod: 20,               // For squeeze confirmation (BB inside Keltner)
    keltnerMultiplier: 1.5,
  },
};
```

### Indicators

| Indicator | Parameters | Purpose |
|-----------|-----------|---------|
| Bollinger Bands | Period=20, StdDev=2.0 on 15m | Volatility compression/expansion |
| BB Width | (Upper - Lower) / Middle | Quantifies squeeze |
| Keltner Channel | Period=20, Multiplier=1.5 on 15m | Squeeze confirmation (BB inside KC) |
| ATR(14) | 14-period on 15m | Trailing stop and TP sizing |
| Volume SMA(20) | 20-period on 15m | Baseline volume for confirmation |
| Volume Ratio | Current / SMA(20) | Breakout strength measure |

### Squeeze Detection

```
function detectSqueeze(data: MarketData):
  candles = data.candles.get("15m")
  bb = BollingerBands(candles.close, params.bbPeriod, params.bbStdDev)
  kc = KeltnerChannel(candles, params.keltnerPeriod, params.keltnerMultiplier)

  // Method 1: BB width percentile
  bbWidths = bb.upper.map((u, i) => (u - bb.lower[i]) / bb.middle[i])
  recentWidths = bbWidths.slice(-params.squeezeLookback)
  currentWidth = bbWidths[-1]
  historicalWidths = bbWidths.slice(0, -params.squeezeLookback)
  percentile = percentileRank(currentWidth, historicalWidths)

  isWidthSqueeze = percentile < params.squeezePercentile

  // Method 2: BB inside Keltner Channel (TTM Squeeze)
  isTtmSqueeze = bb.upper[-1] < kc.upper[-1] AND bb.lower[-1] > kc.lower[-1]

  // Both methods must agree
  isSqueeze = isWidthSqueeze AND isTtmSqueeze

  // Count consecutive squeeze candles
  squeezeCount = 0
  for i in range(len(bbWidths) - 1, -1, -1):
    if bbWidths[i] in bottom percentile AND bb.upper[i] < kc.upper[i]:
      squeezeCount++
    else:
      break

  return { isSqueeze, squeezeCount, currentWidth, percentile }
```

### Entry Logic

```
function analyzeForEntry(data: MarketData):
  squeeze = detectSqueeze(data)

  if not squeeze.isSqueeze:
    // Check if we JUST exited a squeeze (breakout happening now)
    prevSqueeze = state.customState.wasSqueeze
    if not prevSqueeze:
      state.customState.wasSqueeze = false
      return null

  if squeeze.isSqueeze:
    state.customState.wasSqueeze = true
    state.customState.squeezeCount = squeeze.squeezeCount
    if squeeze.squeezeCount < params.minSqueezeCandles:
      return null  // Squeeze not mature enough
    return null    // Wait for breakout (don't enter during squeeze)

  // We're here because we were IN a squeeze and now we're NOT = breakout
  candles = data.candles.get("15m")
  bb = BollingerBands(candles.close, params.bbPeriod, params.bbStdDev)

  // Determine breakout direction
  close = candles[-1].close
  if close > bb.upper[-1]:
    direction = "long"
  elif close < bb.lower[-1]:
    direction = "short"
  else:
    state.customState.wasSqueeze = false
    return null  // Not a clean breakout

  // Volume confirmation
  volumeSma = SMA(candles.volume, 20)
  volumeRatio = candles[-1].volume / volumeSma[-1]
  if volumeRatio < params.volumeConfirmationMultiple:
    return null  // No volume behind breakout

  // False breakout filter (optional)
  if params.falseBreakoutFilter:
    // Check if price closed back inside BB on any of the last N candles
    recentCandles = candles.slice(-params.falseBreakoutRetestCandles)
    for c in recentCandles:
      if direction == "long" AND c.close < bb.upper[-1]:
        // Price retested -- this is actually good if it held
        // But if the very latest candle is back inside, skip
        if c == candles[-1]:
          return null  // False breakout
      if direction == "short" AND c.close > bb.lower[-1]:
        if c == candles[-1]:
          return null

  // Build signal
  atr = ATR(candles, params.atrPeriod)
  confidence = clamp(0.5 + (volumeRatio - 1) * 0.15 + squeeze.squeezeCount * 0.02, 0.5, 0.9)

  if confidence < params.minConfidence:
    return null

  stop_distance = atr[-1] * params.atrTrailingStopMultiplier
  tp_distance   = atr[-1] * params.atrTakeProfitMultiplier

  entry = data.markPrice
  stop  = direction == "long" ? entry - stop_distance : entry + stop_distance
  tp1   = direction == "long" ? entry + tp_distance * 0.5 : entry - tp_distance * 0.5
  tp2   = direction == "long" ? entry + tp_distance       : entry - tp_distance

  return Signal {
    direction,
    confidence,
    suggestedEntry: entry,
    suggestedStopLoss: stop,
    suggestedTakeProfit: [tp1, tp2],
    suggestedOrderType: "market",       // Market order for breakout (speed matters)
    timeInForce: "IOC",
    maxSlippageBps: 8,
    reasoning: `BB squeeze breakout ${direction}, squeeze lasted ${squeeze.squeezeCount} candles, volume ratio ${volumeRatio.toFixed(1)}x`,
    indicators: { bbWidth: squeeze.currentWidth, volumeRatio, squeezeCount: squeeze.squeezeCount },
  }
```

### Exit Logic

```
function analyzeForExit(data: MarketData, position: Position):
  candles = data.candles.get("15m")
  atr = ATR(candles, params.atrPeriod)

  // ATR trailing stop
  trailingStop = position.side == "long"
    ? data.markPrice - atr[-1] * params.atrTrailingStopMultiplier
    : data.markPrice + atr[-1] * params.atrTrailingStopMultiplier

  // Only move stop in profitable direction
  if position.side == "long" AND trailingStop > currentStopPrice:
    updateStopLoss(position, trailingStop)
  if position.side == "short" AND trailingStop < currentStopPrice:
    updateStopLoss(position, trailingStop)

  // Exit if price re-enters Bollinger Band (trend exhaustion)
  bb = BollingerBands(candles.close, params.bbPeriod, params.bbStdDev)
  if position.side == "long" AND candles[-1].close < bb.middle[-1]:
    return Signal { direction: "close_long", reasoning: "Price fell below BB midline" }
  if position.side == "short" AND candles[-1].close > bb.middle[-1]:
    return Signal { direction: "close_short", reasoning: "Price rose above BB midline" }

  return null
```

### Edge Cases and Failure Modes

| Scenario | Handling |
|----------|----------|
| False breakout (price reverses immediately) | Volume confirmation filter. Optional retest confirmation (wait N candles). Tight stop loss. |
| Breakout into low liquidity | Check order book depth before entry. Skip if insufficient liquidity at target size. |
| Multiple squeezes on different timeframes | Use 15m as primary. Confirm with 1h (higher timeframe squeeze = stronger signal). |
| Choppy market (constant small squeezes) | Minimum squeeze duration filter (5 candles). Daily trade limit prevents overtrading. |
| Gap breakout (price jumps past bands) | Market order with max slippage. If slippage exceeds 8 bps, order cancels (IOC). |
| Squeeze but no breakout (range continues) | No action taken during squeeze. Only act on confirmed break of BB. |

### Backtesting Approach

- **Data**: 15-minute candles with volume, minimum 60 days
- **Key setup**: Count squeeze events, measure breakout success rate (% that produce >2x ATR move)
- **Execution**: Market order with 5 bps slippage + 0.035% taker fee
- **Filter optimization**: Test different squeeze durations (3, 5, 7, 10 candles) and volume thresholds (1.5x, 2x, 2.5x, 3x)
- **Regime analysis**: Success rate in trending vs. choppy markets (use ADX to classify)

---

## 8. Strategy 5: GridTrader

### Overview

Automated grid trading strategy for ranging/sideways markets. Places buy and sell limit orders at regular intervals around the current price. ATR-based grid spacing adapts to current volatility. Profits from oscillating price action by repeatedly buying low and selling high within the grid.

### Configuration

```typescript
const GridTraderConfig: SkillConfig = {
  id: "grid-trader",
  name: "Grid Trader",
  version: "1.0.0",
  description: "ATR-adaptive grid trading for ranging markets",
  author: "tenacitas",
  enabled: true,
  assets: ["BTC", "ETH"],
  requiredTimeframes: ["5m", "15m", "1h", "4h"],
  requiredCandleHistory: 100,
  requiresOrderBook: true,
  requiresRecentTrades: false,
  requiresFunding: true,
  tickIntervalMs: 10_000,            // Check every 10 seconds
  maxConcurrentPositions: 1,         // Grid is one "position" with many orders
  risk: {
    maxPositionSizePct: 15,          // Total grid allocation
    maxTotalExposurePct: 20,
    maxLeverage: 3,
    stopLossPct: 5,                  // Wide stop for grid (entire grid invalidation)
    maxDailyLossPct: 3,
    maxDrawdownPct: 8,
    maxTradesPerHour: 60,            // Grids trade frequently
    maxOpenPositions: 2,
    cooldownAfterLossMs: 300_000,
  },
  params: {
    gridLevels: 10,                  // Number of grid levels on each side
    gridSpacingMethod: "atr",        // "fixed_pct" | "atr" | "fibonacci"
    atrPeriod: 14,
    atrGridMultiplier: 0.3,          // Each grid level = 0.3 * ATR apart
    fixedSpacingPct: 0.2,            // If using fixed: 0.2% between levels
    sizePerLevel: "equal",           // "equal" | "pyramiding" | "inverse_pyramiding"
    totalGridSizeUsd: 5000,          // Total USD allocated to the grid
    autoRecenter: true,              // Recenter grid if price moves beyond grid
    recenterThreshold: 0.7,          // Recenter when 70% of one side is filled
    trendFilter: true,               // Don't grid in trending markets
    adxPeriod: 14,
    adxTrendThreshold: 30,           // ADX > 30 = trending = pause grid
    minSpreadBps: 1,
    fundingRateLimit: 0.001,         // Pause if funding rate > 0.1% (trending signal)
  },
};
```

### Grid Structure

```
          Upper Boundary (grid top)
    Sell 5 ─────────────────────── Level +5
    Sell 4 ─────────────────────── Level +4
    Sell 3 ─────────────────────── Level +3
    Sell 2 ─────────────────────── Level +2
    Sell 1 ─────────────────────── Level +1
    ──────── CENTER PRICE ──────── Level  0
    Buy  1 ─────────────────────── Level -1
    Buy  2 ─────────────────────── Level -2
    Buy  3 ─────────────────────── Level -3
    Buy  4 ─────────────────────── Level -4
    Buy  5 ─────────────────────── Level -5
          Lower Boundary (grid bottom)
```

### Grid Initialization

```
function initializeGrid(data: MarketData, portfolio: Portfolio):
  centerPrice = data.markPrice
  atr = ATR(data.candles.get("1h"), params.atrPeriod)

  // Calculate grid spacing
  if params.gridSpacingMethod == "atr":
    spacing = atr[-1] * params.atrGridMultiplier
  elif params.gridSpacingMethod == "fixed_pct":
    spacing = centerPrice * params.fixedSpacingPct / 100

  // Calculate size per level
  totalSizeUsd = min(params.totalGridSizeUsd, portfolio.totalEquity * params.risk.maxPositionSizePct / 100)
  if params.sizePerLevel == "equal":
    sizePerLevel = totalSizeUsd / (params.gridLevels * 2) / centerPrice
  elif params.sizePerLevel == "pyramiding":
    // More size at edges (buy more at lower prices)
    weights = [1, 1.2, 1.4, 1.6, 1.8, 2.0, 2.2, 2.4, 2.6, 2.8]
    totalWeight = sum(weights) * 2
    sizePerLevel = (level) => totalSizeUsd * weights[abs(level) - 1] / totalWeight / centerPrice

  // Create grid levels
  grid = {
    center: centerPrice,
    spacing: spacing,
    levels: [],
    upperBound: centerPrice + spacing * params.gridLevels,
    lowerBound: centerPrice - spacing * params.gridLevels,
  }

  for i in range(1, params.gridLevels + 1):
    // Sell levels (above center)
    grid.levels.push({
      level: i,
      price: centerPrice + spacing * i,
      side: "short",
      size: typeof sizePerLevel == "function" ? sizePerLevel(i) : sizePerLevel,
      orderId: null,
      filled: false,
    })

    // Buy levels (below center)
    grid.levels.push({
      level: -i,
      price: centerPrice - spacing * i,
      side: "long",
      size: typeof sizePerLevel == "function" ? sizePerLevel(-i) : sizePerLevel,
      orderId: null,
      filled: false,
    })

  state.customState.grid = grid
  return grid
```

### Grid Management (Tick Logic)

```
function analyze(data: MarketData, portfolio: Portfolio):
  grid = state.customState.grid

  // 1. Trend filter - pause grid in trending markets
  if params.trendFilter:
    candles_4h = data.candles.get("4h")
    adx = ADX(candles_4h, params.adxPeriod)
    if adx[-1] > params.adxTrendThreshold:
      // Market is trending, don't open new grid orders
      // But keep existing orders to avoid cancel/replace churn
      return null

  // 2. Funding rate check
  if abs(data.funding.rate) > params.fundingRateLimit:
    // High funding suggests directional bias, grid may lose
    return null

  // 3. Check grid health and recenter if needed
  filledBuyLevels = grid.levels.filter(l => l.side == "long" AND l.filled).length
  filledSellLevels = grid.levels.filter(l => l.side == "short" AND l.filled).length
  totalLevels = params.gridLevels

  // If too many levels on one side are filled, price has moved significantly
  if filledBuyLevels / totalLevels > params.recenterThreshold:
    // Price dropped a lot -- recenter grid around current price
    if params.autoRecenter:
      cancelAllGridOrders()
      initializeGrid(data, portfolio)
      placeGridOrders()
      return null

  if filledSellLevels / totalLevels > params.recenterThreshold:
    if params.autoRecenter:
      cancelAllGridOrders()
      initializeGrid(data, portfolio)
      placeGridOrders()
      return null

  // 4. Replace filled levels
  // When a buy order fills, place a corresponding sell order one level up
  // When a sell order fills, place a corresponding buy order one level down
  for level in grid.levels:
    if level.filled AND not level.counterOrderPlaced:
      if level.side == "long":
        // Bought at this level, place sell one level up
        sellPrice = level.price + grid.spacing
        placeLimitOrder("short", sellPrice, level.size, reduceOnly=true)
        level.counterOrderPlaced = true
      elif level.side == "short":
        buyPrice = level.price - grid.spacing
        placeLimitOrder("long", buyPrice, level.size, reduceOnly=true)
        level.counterOrderPlaced = true

  // 5. Ensure all unfilled levels have active orders
  for level in grid.levels:
    if not level.filled AND level.orderId == null:
      order = placeLimitOrder(level.side, level.price, level.size)
      level.orderId = order.id

  return null  // Grid manages itself through orders, not signals
```

### Grid Stop Loss (Full Grid Invalidation)

```
function checkGridStopLoss(data: MarketData, portfolio: Portfolio):
  grid = state.customState.grid

  // If price breaks beyond grid boundaries with momentum, close everything
  if data.markPrice > grid.upperBound * 1.02:
    // Price blew through grid top by 2% -- close all and stop
    return { action: "close_all", reason: "Price exceeded grid upper boundary" }

  if data.markPrice < grid.lowerBound * 0.98:
    return { action: "close_all", reason: "Price exceeded grid lower boundary" }

  // Check total grid P&L
  gridPnl = calculateGridPnl(grid, data.markPrice)
  if gridPnl / params.totalGridSizeUsd < -params.risk.stopLossPct / 100:
    return { action: "close_all", reason: "Grid stop loss hit" }

  return null
```

### Edge Cases and Failure Modes

| Scenario | Handling |
|----------|----------|
| Breakout from range (trending move) | ADX trend filter pauses new orders. Grid stop loss closes at boundary breach. |
| Flash crash through entire grid | All buy levels fill, stop loss at lower boundary + 2%. Recenter on recovery. |
| Order fill race condition | Track orders by exchange ID. Reconcile state on each tick. |
| High funding rate accrual | Funding rate limit pauses grid. Monitor cumulative funding cost. |
| Grid spacing too tight (fee drag) | Minimum spacing validation: grid spacing must be > 4x taker fee to be profitable. |
| API rate limits from many orders | Batch order placement. Use Hyperliquid bulk order endpoint. |
| Price sits between levels | Normal operation. Grid profits from oscillation, not from holding. |

### Backtesting Approach

- **Data**: 5-minute candles for 90+ days, with bid-ask spread data
- **Execution model**: Limit orders fill when price touches level. Include maker fee (0.02% rebate on Hyperliquid).
- **Key metrics**: Total grid profit, number of round trips, profit per round trip, max adverse excursion
- **Optimization targets**: Grid spacing (0.1-0.5% or 0.1-0.5x ATR), number of levels (5-20)
- **Regime classification**: Separate results for trending vs. ranging periods. Strategy should be profitable in ranging, stopped out quickly in trending.

---

## 9. Risk Management Framework

### 9.1 Per-Skill Risk Controls

Each skill has its own `SkillRiskConfig` (defined in section 2.7). The skill's `riskCheck()` method enforces these limits before any signal is forwarded to the execution layer.

```typescript
interface SkillRiskCheck {
  // Called internally by each skill
  check(signal: Signal, portfolio: Portfolio, skillState: SkillState): RiskCheckResult;
}

interface RiskCheckResult {
  approved: boolean;
  reason?: string;
  adjustedSignal?: Signal;  // Signal with reduced size/leverage if partially approved
}
```

#### Per-Skill Checks (in order)

1. **Daily loss limit**: If `skillState.dailyPnl < -portfolio.totalEquity * risk.maxDailyLossPct / 100`, reject all signals.
2. **Drawdown limit**: If `skillState.maxDrawdown > risk.maxDrawdownPct`, pause skill entirely.
3. **Consecutive loss circuit breaker**: If `skillState.consecutiveLosses >= 5`, pause skill for 30 minutes.
4. **Trade frequency**: If trades in last hour >= `risk.maxTradesPerHour`, reject signal.
5. **Cooldown timer**: If `Date.now() - skillState.lastTradeAt < risk.cooldownAfterLossMs` (only after losing trade), reject.
6. **Position count**: If open positions >= `risk.maxOpenPositions`, reject new entries (allow exits).
7. **Position size cap**: If `signal.suggestedSize * signal.suggestedEntry > portfolio.totalEquity * risk.maxPositionSizePct / 100`, reduce size.
8. **Leverage cap**: If `signal.suggestedLeverage > risk.maxLeverage`, reduce to max.

### 9.2 Portfolio-Level Risk Controls

The global `RiskManager` applies portfolio-wide limits after skill-level risk checks pass.

```typescript
interface PortfolioRiskConfig {
  maxTotalExposurePct: number;         // 50% -- max sum of |position notional| / equity
  maxSingleAssetExposurePct: number;   // 20% -- max exposure to any single asset
  maxCorrelatedExposurePct: number;    // 30% -- max exposure to correlated group
  maxDailyPortfolioLossPct: number;    // 5%  -- hard stop for the day
  maxPortfolioDrawdownPct: number;     // 10% -- hard stop, human review required
  minFreeMarginPct: number;           // 30% -- always keep 30% margin free
  maxPendingOrders: number;            // 50  -- prevent order spam

  // Correlation groups (assets that move together)
  correlationGroups: {
    name: string;
    assets: string[];
  }[];
}

const defaultPortfolioRiskConfig: PortfolioRiskConfig = {
  maxTotalExposurePct: 50,
  maxSingleAssetExposurePct: 20,
  maxCorrelatedExposurePct: 30,
  maxDailyPortfolioLossPct: 5,
  maxPortfolioDrawdownPct: 10,
  minFreeMarginPct: 30,
  maxPendingOrders: 50,
  correlationGroups: [
    { name: "L1", assets: ["ETH", "SOL", "AVAX", "SUI", "APT"] },
    { name: "L2", assets: ["ARB", "OP", "MATIC"] },
    { name: "meme", assets: ["DOGE", "PEPE", "WIF"] },
  ],
};
```

#### Portfolio-Level Checks (in order)

```
function portfolioRiskCheck(signal: Signal, portfolio: Portfolio, config: PortfolioRiskConfig):
  // 1. Daily portfolio loss
  if portfolio.totalRealizedPnl + portfolio.totalUnrealizedPnl < -portfolio.totalEquity * config.maxDailyPortfolioLossPct / 100:
    return { approved: false, reason: "Daily portfolio loss limit reached" }

  // 2. Portfolio drawdown
  if portfolio.maxDrawdownSession > config.maxPortfolioDrawdownPct:
    return { approved: false, reason: "Portfolio drawdown limit reached -- human review required" }

  // 3. Total exposure
  newNotional = signal.suggestedSize * signal.suggestedEntry * signal.suggestedLeverage
  totalExposure = portfolio.totalExposure + newNotional
  if totalExposure > portfolio.totalEquity * config.maxTotalExposurePct / 100:
    // Try to reduce size to fit
    availableExposure = portfolio.totalEquity * config.maxTotalExposurePct / 100 - portfolio.totalExposure
    if availableExposure <= 0:
      return { approved: false, reason: "Total exposure limit reached" }
    adjustedSize = availableExposure / (signal.suggestedEntry * signal.suggestedLeverage)
    signal.suggestedSize = adjustedSize
    // Continue with reduced size

  // 4. Single asset exposure
  existingAssetExposure = sum(portfolio.positions.filter(p => p.asset == signal.asset).map(p => p.size * p.markPrice))
  if existingAssetExposure + newNotional > portfolio.totalEquity * config.maxSingleAssetExposurePct / 100:
    return { approved: false, reason: `Single asset exposure limit for ${signal.asset}` }

  // 5. Correlated exposure
  for group in config.correlationGroups:
    if signal.asset in group.assets:
      groupExposure = sum(portfolio.positions.filter(p => p.asset in group.assets).map(p => p.size * p.markPrice))
      if groupExposure + newNotional > portfolio.totalEquity * config.maxCorrelatedExposurePct / 100:
        return { approved: false, reason: `Correlated exposure limit for ${group.name} group` }

  // 6. Free margin
  requiredMargin = newNotional / signal.suggestedLeverage
  if portfolio.availableMargin - requiredMargin < portfolio.totalEquity * config.minFreeMarginPct / 100:
    return { approved: false, reason: "Insufficient free margin (minimum margin buffer)" }

  // 7. Pending order count
  if portfolio.openOrders.length >= config.maxPendingOrders:
    return { approved: false, reason: "Too many pending orders" }

  return { approved: true, adjustedSignal: signal }
```

### 9.3 Kill Switch Specification

The kill switch is the final safety mechanism. When triggered, it immediately:
1. Cancels ALL open orders across ALL skills
2. Closes ALL open positions at market
3. Pauses ALL skills
4. Sends an alert notification
5. Requires human intervention to resume

```typescript
interface KillSwitchConfig {
  enabled: boolean;

  // Automatic triggers
  triggers: {
    portfolioDrawdownPct: number;       // 10% -- hard stop
    portfolioLossAbsolute: number;      // $X absolute loss
    rapidLossDetection: {
      lossPct: number;                  // 3% loss
      withinMinutes: number;            // within 5 minutes
    };
    apiErrorRate: {
      threshold: number;               // 50% of API calls failing
      withinMinutes: number;            // over 2 minutes
    };
    positionSizeAnomaly: {
      maxSinglePositionPct: number;     // Any single position > 25% of equity
    };
    priceFeedStale: {
      maxStaleSeconds: number;          // No price update for 30 seconds
    };
    liquidationProximity: {
      marginRatioPct: number;           // Maintenance margin ratio < 150%
    };
  };

  // Notification channels
  notifications: {
    webhook?: string;                   // Webhook URL for alerts
    email?: string;
  };
}

const defaultKillSwitchConfig: KillSwitchConfig = {
  enabled: true,
  triggers: {
    portfolioDrawdownPct: 10,
    portfolioLossAbsolute: 10_000,
    rapidLossDetection: { lossPct: 3, withinMinutes: 5 },
    apiErrorRate: { threshold: 0.5, withinMinutes: 2 },
    positionSizeAnomaly: { maxSinglePositionPct: 25 },
    priceFeedStale: { maxStaleSeconds: 30 },
    liquidationProximity: { marginRatioPct: 150 },
  },
  notifications: {},
};
```

#### Kill Switch Execution

```
function executeKillSwitch(reason: string):
  log.critical(`KILL SWITCH ACTIVATED: ${reason}`)

  // 1. Cancel all orders (single API call on Hyperliquid)
  await hyperliquid.cancelAllOrders()

  // 2. Close all positions at market
  for position in portfolio.positions:
    side = position.side == "long" ? "short" : "long"
    await hyperliquid.placeOrder({
      asset: position.asset,
      side: side,
      size: position.size,
      orderType: "market",
      reduceOnly: true,
    })

  // 3. Pause all skills
  for skill in skillRegistry.listSkills():
    skill.state.status = "stopped"
    await skill.shutdown("kill_switch")

  // 4. Send notification
  await sendNotification({
    type: "kill_switch",
    reason,
    portfolioSnapshot: takePortfolioSnapshot(),
    timestamp: Date.now(),
  })

  // 5. Set global trading halt flag
  globalState.tradingHalted = true
  globalState.haltReason = reason
  globalState.haltedAt = Date.now()
  // Requires manual: globalState.tradingHalted = false to resume
```

### 9.4 Slippage Tolerance and Execution Quality

```typescript
interface ExecutionQualityConfig {
  maxSlippageBps: number;             // Per-order max slippage (default: 10 bps)
  slippageWarningBps: number;         // Log warning above this (default: 5 bps)
  maxRetries: number;                 // Order retry attempts (default: 2)
  retryDelayMs: number;               // Delay between retries (default: 500)
  executionTimeoutMs: number;         // Max time to wait for fill (default: 5000)
}

interface ExecutionReport {
  orderId: string;
  expectedPrice: number;
  actualPrice: number;
  slippageBps: number;
  fillLatencyMs: number;              // Time from submission to fill
  partialFill: boolean;
  retryCount: number;
}
```

#### Slippage Monitoring

```
function monitorExecutionQuality(report: ExecutionReport):
  // Track rolling slippage metrics
  recentSlippages.push(report.slippageBps)
  if recentSlippages.length > 100:
    recentSlippages.shift()

  avgSlippage = mean(recentSlippages)
  p95Slippage = percentile(recentSlippages, 95)

  if avgSlippage > config.slippageWarningBps:
    log.warn(`Average slippage elevated: ${avgSlippage.toFixed(1)} bps`)

  if p95Slippage > config.maxSlippageBps:
    log.warn(`P95 slippage exceeds max: ${p95Slippage.toFixed(1)} bps -- consider reducing order sizes`)

  // If slippage consistently too high, reduce position sizes
  if avgSlippage > config.maxSlippageBps for 10 consecutive trades:
    reduceSizeFactor = 0.5
    log.warn(`Reducing position sizes by ${reduceSizeFactor}x due to persistent slippage`)
```

---

## 10. Hyperliquid Integration

### 10.1 API Architecture

Hyperliquid exposes two primary interfaces:

| Interface | Base URL | Purpose |
|-----------|----------|---------|
| REST (Info) | `https://api.hyperliquid.xyz/info` | Market data, account info, historical data |
| REST (Exchange) | `https://api.hyperliquid.xyz/exchange` | Order placement, cancellation, account actions |
| WebSocket | `wss://api.hyperliquid.xyz/ws` | Real-time market data, order updates |

All REST endpoints accept POST requests with JSON bodies. There are no GET endpoints.

### 10.2 Authentication (EIP-712 Signatures)

Hyperliquid uses EIP-712 typed data signatures for authentication. This is Cloudflare Workers compatible because it uses standard cryptographic operations.

```typescript
interface HyperliquidAuth {
  // The wallet address (public key derived from private key)
  address: string;
  // The private key (stored securely, never logged)
  privateKey: string;
}

// EIP-712 Domain
const EIP712_DOMAIN = {
  name: "Exchange",
  version: "1",
  chainId: 1337, // Hyperliquid L1 chain ID (for mainnet; testnet = 421614)
  verifyingContract: "0x0000000000000000000000000000000000000000",
};

// Signing flow
function signAction(action: object, nonce: number, auth: HyperliquidAuth): Signature {
  const typedData = {
    domain: EIP712_DOMAIN,
    types: {
      // Type definitions depend on the action
      // e.g., for orders: { Order: [...field types] }
    },
    primaryType: "Exchange", // or appropriate type
    message: {
      action,
      nonce,
      // Additional fields as required
    },
  };

  // Use ethers.js or viem (both work in CF Workers)
  // viem is recommended for smaller bundle size
  const signature = await signTypedData({
    privateKey: auth.privateKey,
    ...typedData,
  });

  return signature;
}
```

**Cloudflare Workers Compatibility Notes:**
- Use `viem` for EIP-712 signing (tree-shakeable, no Node.js dependencies).
- `crypto.subtle` is available in Workers for any additional hashing.
- Private key must be stored in Cloudflare Worker secrets (`wrangler secret put PRIVATE_KEY`), never in code or environment variables in plaintext.

### 10.3 REST API Endpoints

#### Info API (`POST /info`)

```typescript
// Market data
{ type: "meta" }                              // All available assets and their details
{ type: "allMids" }                           // Current mid prices for all assets
{ type: "l2Book", coin: "ETH" }              // Order book snapshot
{ type: "recentTrades", coin: "ETH" }        // Recent trades

// Candle data
{ type: "candleSnapshot", req: { coin: "ETH", interval: "15m", startTime: 1700000000000, endTime: 1700086400000 } }

// Account data (requires no signature for read-only)
{ type: "clearinghouseState", user: "0x..." }  // Positions, margin, equity
{ type: "openOrders", user: "0x..." }          // Open orders
{ type: "userFills", user: "0x..." }           // Recent fills
{ type: "userFunding", user: "0x...", startTime: 1700000000000, endTime: 1700086400000 } // Funding payments

// Funding rates
{ type: "fundingHistory", coin: "ETH", startTime: 1700000000000, endTime: 1700086400000 }
{ type: "predictedFundings" }                  // Next predicted funding rates
```

#### Exchange API (`POST /exchange`)

All exchange requests require EIP-712 signature.

```typescript
// Place order
{
  action: {
    type: "order",
    orders: [{
      a: 1,                    // Asset index (from meta endpoint)
      b: true,                 // isBuy
      p: "3500.0",             // Price (string)
      s: "0.1",                // Size (string)
      r: false,                // Reduce only
      t: {                     // Order type
        limit: { tif: "Gtc" }  // "Gtc" | "Ioc" | "Alo" (add liquidity only)
      },
      // OR for trigger orders:
      t: {
        trigger: {
          isMarket: true,
          triggerPx: "3400.0",
          tpsl: "sl",           // "sl" (stop loss) | "tp" (take profit)
        }
      }
    }],
    grouping: "na",             // "na" (normal) | "normalTpsl" (with TP/SL) | "positionTpsl"
  },
  nonce: Date.now(),
  signature: "0x...",
}

// Cancel order
{
  action: {
    type: "cancel",
    cancels: [{
      a: 1,                    // Asset index
      o: 12345,                // Order ID
    }],
  },
  nonce: Date.now(),
  signature: "0x...",
}

// Cancel all orders for an asset
{
  action: {
    type: "cancelByCloid",
    cancels: [{ asset: 1 }],
  },
  nonce: Date.now(),
  signature: "0x...",
}

// Modify order (cancel + replace atomically)
{
  action: {
    type: "batchModify",
    modifies: [{
      oid: 12345,
      order: { /* same as place order fields */ },
    }],
  },
  nonce: Date.now(),
  signature: "0x...",
}

// Update leverage
{
  action: {
    type: "updateLeverage",
    asset: 1,
    isCross: true,             // Cross margin vs. isolated
    leverage: 5,
  },
  nonce: Date.now(),
  signature: "0x...",
}
```

### 10.4 WebSocket Feeds

```typescript
// Connection
const ws = new WebSocket("wss://api.hyperliquid.xyz/ws");

// Subscribe to feeds
ws.send(JSON.stringify({
  method: "subscribe",
  subscription: { type: "allMids" },      // All mid prices, updates every ~1s
}));

ws.send(JSON.stringify({
  method: "subscribe",
  subscription: { type: "l2Book", coin: "ETH" },  // Order book updates
}));

ws.send(JSON.stringify({
  method: "subscribe",
  subscription: { type: "trades", coin: "ETH" },   // Trade feed
}));

ws.send(JSON.stringify({
  method: "subscribe",
  subscription: { type: "candle", coin: "ETH", interval: "1m" },  // Candle updates
}));

// User-specific (requires signing a nonce)
ws.send(JSON.stringify({
  method: "subscribe",
  subscription: { type: "orderUpdates", user: "0x..." },
}));

ws.send(JSON.stringify({
  method: "subscribe",
  subscription: { type: "userFills", user: "0x..." },
}));
```

#### WebSocket Message Format

```typescript
// Mid prices
{ channel: "allMids", data: { mids: { "ETH": "3500.5", "BTC": "62000.1", ... } } }

// L2 Book
{ channel: "l2Book", data: {
  coin: "ETH",
  levels: [
    [/* bids */[["3499.5", "10.5"], ["3499.0", "25.2"], ...]],
    [/* asks */[["3500.5", "8.3"], ["3501.0", "15.7"], ...]],
  ],
  time: 1700000000000,
}}

// Trades
{ channel: "trades", data: [{
  coin: "ETH",
  side: "B",          // "B" = buy, "A" = sell
  px: "3500.5",
  sz: "1.2",
  time: 1700000000000,
  hash: "0x...",
  liquidation: false,
}]}

// Order updates
{ channel: "orderUpdates", data: [{
  order: { /* order details */ },
  status: "filled",    // "open" | "filled" | "canceled" | "triggered"
  statusTimestamp: 1700000000000,
}]}
```

### 10.5 Data Requirements Per Strategy

| Strategy | REST Endpoints | WebSocket Feeds | Tick Rate |
|----------|---------------|-----------------|-----------|
| MomentumScalper | `candleSnapshot` (15s, 1m), `l2Book` | `trades`, `l2Book`, `allMids` | 1s |
| SentimentAnalyzer | `candleSnapshot` (5m, 15m, 1h), `fundingHistory` | `allMids` | 60s |
| MeanReversion | `candleSnapshot` (1h, 4h), `fundingHistory`, `predictedFundings` | `allMids` | 30s |
| BreakoutHunter | `candleSnapshot` (5m, 15m, 1h), `l2Book` | `trades`, `l2Book`, `allMids` | 5s |
| GridTrader | `candleSnapshot` (5m, 15m, 1h, 4h), `l2Book` | `allMids`, `orderUpdates`, `userFills` | 10s |

### 10.6 Rate Limits

Hyperliquid rate limits (as of early 2025):

| Endpoint | Limit | Window |
|----------|-------|--------|
| Info API | 1200 requests | per minute |
| Exchange API | 1200 requests | per minute |
| WebSocket subscriptions | 100 subscriptions | per connection |
| Order placement | ~10 orders | per second |
| Bulk order placement | 1 batch of up to 20 orders | per request |

#### Rate Limit Handling

```typescript
interface RateLimiter {
  // Token bucket implementation
  bucket: {
    tokens: number;
    maxTokens: number;
    refillRate: number;        // Tokens per second
    lastRefill: number;
  };

  // Check if request can proceed
  tryAcquire(): boolean;

  // Wait until token is available
  waitForToken(): Promise<void>;
}

// Per-endpoint rate limiters
const rateLimiters = {
  info: new RateLimiter({ maxTokens: 1200, refillRate: 20 }),   // 20/s = 1200/min
  exchange: new RateLimiter({ maxTokens: 1200, refillRate: 20 }),
  orders: new RateLimiter({ maxTokens: 10, refillRate: 10 }),   // 10/s burst
};

// Usage
async function apiCall(endpoint: "info" | "exchange", body: object) {
  await rateLimiters[endpoint].waitForToken();
  const response = await fetch(`https://api.hyperliquid.xyz/${endpoint}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (response.status === 429) {
    // Back off exponentially
    await delay(1000);
    return apiCall(endpoint, body); // Retry once
  }

  return response.json();
}
```

### 10.7 Order Types and Use Cases

| Order Type | Hyperliquid TIF | Use Case |
|-----------|----------------|----------|
| Market (IOC) | `{ limit: { tif: "Ioc" } }` at far price | MomentumScalper entries, kill switch exits |
| Limit GTC | `{ limit: { tif: "Gtc" } }` | GridTrader levels, MeanReversion entries |
| Limit ALO | `{ limit: { tif: "Alo" } }` | Maker-only orders (capture rebate) |
| Stop Loss (market) | `{ trigger: { isMarket: true, tpsl: "sl" } }` | All strategies -- protective stops |
| Take Profit (market) | `{ trigger: { isMarket: true, tpsl: "tp" } }` | All strategies -- profit targets |
| Stop Limit | `{ trigger: { isMarket: false, tpsl: "sl" } }` | MeanReversion -- limit stop in liquid markets |

**Note on market orders**: Hyperliquid doesn't have a native "market" order. Market orders are implemented as aggressive limit orders with IOC time-in-force, priced at a worst-case level (e.g., 3% from current price for longs).

---

## 11. Signal Aggregation

When multiple skills produce signals for the same asset, the aggregation layer resolves them into a single action.

### 11.1 Aggregation Architecture

```typescript
interface AggregatedSignal {
  asset: string;
  timestamp: number;
  direction: SignalDirection;
  confidence: number;
  contributingSignals: Signal[];
  aggregationMethod: "weighted_consensus" | "strongest_wins" | "unanimous_required";
}

interface SignalAggregator {
  aggregate(signals: Signal[], config: AggregationConfig): AggregatedSignal | null;
}

interface AggregationConfig {
  method: "weighted_consensus" | "strongest_wins" | "unanimous_required";
  minAgreementPct: number;       // Min % of signals that must agree on direction
  minAggregatedConfidence: number; // Min weighted confidence to act
  skillWeights: Record<string, number>; // Weight per skill
}

const defaultAggregationConfig: AggregationConfig = {
  method: "weighted_consensus",
  minAgreementPct: 0.6,          // 60% of signals must agree
  minAggregatedConfidence: 0.55,
  skillWeights: {
    "momentum-scalper": 1.0,
    "sentiment-analyzer": 0.8,
    "mean-reversion": 1.2,       // Higher weight for statistical strategies
    "breakout-hunter": 1.0,
    "grid-trader": 0.5,          // Lower weight (grid is self-managing)
  },
};
```

### 11.2 Weighted Consensus Algorithm

```
function aggregateSignals(signals: Signal[], config: AggregationConfig):
  if signals.length == 0:
    return null

  // Filter to non-neutral signals
  activeSignals = signals.filter(s => s.direction != "neutral")
  if activeSignals.length == 0:
    return null

  // Group by direction
  longSignals  = activeSignals.filter(s => s.direction == "long" || s.direction == "close_short")
  shortSignals = activeSignals.filter(s => s.direction == "short" || s.direction == "close_long")
  closeSignals = activeSignals.filter(s => s.direction.startsWith("close_"))

  // Calculate weighted scores
  longScore = sum(longSignals.map(s => s.confidence * s.strength * config.skillWeights[s.skillId]))
  shortScore = sum(shortSignals.map(s => s.confidence * s.strength * config.skillWeights[s.skillId]))

  totalWeight = sum(activeSignals.map(s => config.skillWeights[s.skillId]))
  longPct = longScore / (longScore + shortScore)
  shortPct = shortScore / (longScore + shortScore)

  // Check agreement threshold
  if longPct >= config.minAgreementPct:
    direction = "long"
    confidence = longScore / totalWeight
  elif shortPct >= config.minAgreementPct:
    direction = "short"
    confidence = shortScore / totalWeight
  else:
    // No consensus -- skip
    return null

  // Prioritize close signals (always respect exit signals)
  if closeSignals.length > 0:
    // If any skill says close, close (safety first)
    direction = closeSignals[0].direction
    confidence = max(closeSignals.map(s => s.confidence))

  if confidence < config.minAggregatedConfidence:
    return null

  // Use the highest-confidence contributing signal for execution params
  bestSignal = activeSignals.sort((a, b) => b.confidence - a.confidence)[0]

  return AggregatedSignal {
    asset: bestSignal.asset,
    direction,
    confidence,
    contributingSignals: activeSignals,
    // Use best signal's execution parameters
    suggestedEntry: bestSignal.suggestedEntry,
    suggestedStopLoss: bestSignal.suggestedStopLoss,
    suggestedTakeProfit: bestSignal.suggestedTakeProfit,
    suggestedSize: bestSignal.suggestedSize,
    suggestedLeverage: bestSignal.suggestedLeverage,
    suggestedOrderType: bestSignal.suggestedOrderType,
  }
```

### 11.3 Conflict Resolution Rules

| Conflict | Resolution |
|----------|------------|
| Skill A says LONG, Skill B says SHORT | Weighted consensus. If no side reaches `minAgreementPct`, no action. |
| Skill A says LONG, Skill B says CLOSE_LONG | Close takes priority (safety first). Always respect exit signals. |
| Multiple skills agree on direction but different prices | Use the most conservative entry (worst fill price for the direction). |
| One skill has very high confidence, others are neutral | `strongest_wins` mode: Act on that single high-confidence signal if confidence > 0.8. |
| All skills neutral | No action. |
| Grid + directional skill conflict | Grid operates independently (manages its own orders). Directional signals from other skills can pause/unpause the grid. |

### 11.4 Skill Independence Exceptions

Some skills operate independently and do not participate in signal aggregation:

- **GridTrader**: Manages its own orders directly. Other skills' signals can only PAUSE or UNPAUSE the grid, not override its individual orders.
- **MeanReversion**: When in delta-neutral mode, operates independently since it's not directional.

---

## 12. Backtesting Framework

### 12.1 Architecture

```typescript
interface BacktestConfig {
  startDate: number;           // Unix ms
  endDate: number;
  assets: string[];
  skills: SkillConfig[];       // Which skills to test
  initialEquity: number;       // Starting capital in USDC
  fees: {
    makerFeePct: number;       // 0.02% on Hyperliquid (rebate)
    takerFeePct: number;       // 0.035% on Hyperliquid
  };
  slippageModel: "fixed_bps" | "volume_dependent";
  fixedSlippageBps?: number;
  dataSource: "hyperliquid_api" | "local_csv";
}

interface BacktestResult {
  totalReturn: number;         // %
  sharpeRatio: number;
  sortinoRatio: number;
  maxDrawdown: number;         // %
  maxDrawdownDuration: number; // ms
  winRate: number;
  profitFactor: number;
  avgWin: number;
  avgLoss: number;
  totalTrades: number;
  avgTradesPerDay: number;
  avgHoldDuration: number;     // ms
  calmarRatio: number;         // Annual return / max drawdown
  trades: TradeLog[];
  equityCurve: { timestamp: number; equity: number }[];
  dailyReturns: number[];
}
```

### 12.2 Walk-Forward Validation

```
Split data into windows:
  - In-sample: 70% of each window (optimize parameters)
  - Out-of-sample: 30% of each window (validate)

  Window 1: |===== IS =====|=== OOS ===|
  Window 2:     |===== IS =====|=== OOS ===|
  Window 3:         |===== IS =====|=== OOS ===|

  Final metrics = aggregate OOS results only
```

### 12.3 Minimum Acceptable Metrics

| Metric | Minimum Threshold | Description |
|--------|-------------------|-------------|
| Sharpe Ratio | > 1.5 | Annualized, after fees |
| Win Rate | > 45% | Lower acceptable if R:R > 2 |
| Profit Factor | > 1.3 | Gross profits / gross losses |
| Max Drawdown | < 15% | Must survive within risk limits |
| Avg Trades/Day | > 1 | Must trade often enough to be meaningful |
| Calmar Ratio | > 1.0 | Return / max drawdown |

---

## Appendix A: Indicator Implementations

All indicators must be implemented in pure TypeScript without Node.js dependencies, suitable for Cloudflare Workers.

```typescript
// EMA (Exponential Moving Average)
function ema(data: number[], period: number): number[] {
  const k = 2 / (period + 1);
  const result: number[] = [data[0]];
  for (let i = 1; i < data.length; i++) {
    result.push(data[i] * k + result[i - 1] * (1 - k));
  }
  return result;
}

// ATR (Average True Range)
function atr(candles: Candle[], period: number): number[] {
  const trs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const tr = Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - candles[i - 1].close),
      Math.abs(candles[i].low - candles[i - 1].close)
    );
    trs.push(tr);
  }
  return ema(trs, period);
}

// RSI (Relative Strength Index)
function rsi(data: number[], period: number): number[] {
  const gains: number[] = [];
  const losses: number[] = [];
  for (let i = 1; i < data.length; i++) {
    const change = data[i] - data[i - 1];
    gains.push(change > 0 ? change : 0);
    losses.push(change < 0 ? -change : 0);
  }
  const avgGain = ema(gains, period);
  const avgLoss = ema(losses, period);
  return avgGain.map((g, i) => {
    if (avgLoss[i] === 0) return 100;
    const rs = g / avgLoss[i];
    return 100 - 100 / (1 + rs);
  });
}

// Bollinger Bands
function bollingerBands(data: number[], period: number, stdDevMultiplier: number) {
  const middle = sma(data, period);
  const bands = middle.map((m, i) => {
    const slice = data.slice(Math.max(0, i - period + 1), i + 1);
    const sd = stddev(slice);
    return { upper: m + sd * stdDevMultiplier, middle: m, lower: m - sd * stdDevMultiplier };
  });
  return {
    upper: bands.map(b => b.upper),
    middle: bands.map(b => b.middle),
    lower: bands.map(b => b.lower),
  };
}

// MACD
function macd(data: number[], fastPeriod: number, slowPeriod: number, signalPeriod: number) {
  const fast = ema(data, fastPeriod);
  const slow = ema(data, slowPeriod);
  const macdLine = fast.map((f, i) => f - slow[i]);
  const signalLine = ema(macdLine, signalPeriod);
  const histogram = macdLine.map((m, i) => m - signalLine[i]);
  return { macdLine, signalLine, histogram };
}

// ADX (Average Directional Index)
function adx(candles: Candle[], period: number): number[] {
  // +DM / -DM calculation
  const plusDM: number[] = [];
  const minusDM: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const upMove = candles[i].high - candles[i - 1].high;
    const downMove = candles[i - 1].low - candles[i].low;
    plusDM.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDM.push(downMove > upMove && downMove > 0 ? downMove : 0);
  }
  const atrValues = atr(candles, period);
  const plusDI = ema(plusDM, period).map((d, i) => (d / atrValues[i]) * 100);
  const minusDI = ema(minusDM, period).map((d, i) => (d / atrValues[i]) * 100);
  const dx = plusDI.map((p, i) => (Math.abs(p - minusDI[i]) / (p + minusDI[i])) * 100);
  return ema(dx, period);
}

// Keltner Channel
function keltnerChannel(candles: Candle[], period: number, multiplier: number) {
  const closes = candles.map(c => c.close);
  const middle = ema(closes, period);
  const atrValues = atr(candles, period);
  return {
    upper: middle.map((m, i) => m + atrValues[i] * multiplier),
    middle,
    lower: middle.map((m, i) => m - atrValues[i] * multiplier),
  };
}

// SMA (Simple Moving Average)
function sma(data: number[], period: number): number[] {
  const result: number[] = [];
  for (let i = 0; i < data.length; i++) {
    const start = Math.max(0, i - period + 1);
    const slice = data.slice(start, i + 1);
    result.push(slice.reduce((a, b) => a + b, 0) / slice.length);
  }
  return result;
}

// Standard Deviation
function stddev(data: number[]): number {
  const avg = data.reduce((a, b) => a + b, 0) / data.length;
  const squareDiffs = data.map(d => (d - avg) ** 2);
  return Math.sqrt(squareDiffs.reduce((a, b) => a + b, 0) / data.length);
}
```

---

## Appendix B: Position Sizing Methods

### Fixed Fraction

```
sizePct = config.risk.maxPositionSizePct / 100
sizeUsd = portfolio.totalEquity * sizePct
sizeBase = sizeUsd / entryPrice
```

### ATR-Based (Volatility-Adjusted)

```
// Risk a fixed dollar amount per trade, adjusted by ATR
riskPerTrade = portfolio.totalEquity * 0.01  // 1% risk per trade
atrValue = ATR(candles, 14)[-1]
stopDistance = atrValue * stopMultiplier
sizeBase = riskPerTrade / stopDistance
```

### Kelly Criterion (Quarter Kelly)

```
// Kelly formula: f* = (p * b - q) / b
// p = win probability, q = 1-p, b = avg win / avg loss
winRate = state.winCount / (state.winCount + state.lossCount)
avgWin = state.totalWinAmount / state.winCount
avgLoss = state.totalLossAmount / state.lossCount
b = avgWin / avgLoss
kellyFraction = (winRate * b - (1 - winRate)) / b
quarterKelly = kellyFraction * 0.25  // Quarter Kelly for safety
sizePct = clamp(quarterKelly, 0, config.risk.maxPositionSizePct / 100)
sizeUsd = portfolio.totalEquity * sizePct
```

---

## Appendix C: Cloudflare Workers Constraints

| Constraint | Limit | Impact on Trading System |
|-----------|-------|--------------------------|
| CPU time per request | 30s (paid plan) | Indicator calculations must be efficient |
| Memory | 128 MB | Limit candle history buffer size |
| Subrequest limit | 1000 per request | Batch API calls, use WebSocket for real-time data |
| WebSocket connections | Supported (Durable Objects) | Use Durable Objects for persistent WS connections |
| Cron triggers | Min 1 minute interval | Not suitable for sub-second strategies alone |
| Durable Objects | Yes | Use for persistent state, WebSocket management |
| KV storage | Yes | Use for configuration, historical data cache |
| D1 (SQLite) | Yes | Use for trade logs, backtest results |

### Architecture Decision: Durable Objects for State

Each trading agent should be a **Durable Object** that:
- Maintains a persistent WebSocket connection to Hyperliquid
- Runs the skill tick loop using `setInterval` (available in DO)
- Stores state in Durable Object storage (transactional)
- Exposes an HTTP API for monitoring and control

```typescript
export class TradingAgent implements DurableObject {
  private skills: TradingSkill[] = [];
  private wsConnection: WebSocket | null = null;
  private tickIntervals: Map<string, number> = new Map();

  async fetch(request: Request): Promise<Response> {
    // HTTP API for control plane
  }

  async alarm(): Promise<void> {
    // Durable Object alarm for scheduled tasks
  }

  private startTickLoop(skill: TradingSkill): void {
    const interval = setInterval(async () => {
      const marketData = this.getLatestMarketData(skill.config.assets);
      const signal = await skill.analyze(marketData, this.portfolio);
      if (signal) {
        const checked = await skill.riskCheck(signal, this.portfolio);
        if (checked) {
          const globalChecked = await this.riskManager.validate(checked, this.portfolio);
          if (globalChecked) {
            const orders = await skill.createOrders(globalChecked, this.portfolio);
            await this.submitOrders(orders);
          }
        }
      }
    }, skill.config.tickIntervalMs);
    this.tickIntervals.set(skill.config.id, interval);
  }
}
```
