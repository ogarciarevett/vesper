# TradingRoom Product Specification

**Version:** 1.0.0
**Status:** Draft
**Last Updated:** 2026-02-14

---

## Table of Contents

1. [Product Overview](#1-product-overview)
2. [Core Concepts](#2-core-concepts)
3. [User Stories](#3-user-stories)
4. [System Architecture](#4-system-architecture)
5. [WebSocket Protocol](#5-websocket-protocol)
6. [Trading Flow](#6-trading-flow)
7. [Strategy Skills](#7-strategy-skills)
8. [Risk Management](#8-risk-management)
9. [Multi-Market Support](#9-multi-market-support)
10. [Best Price Aggregation](#10-best-price-aggregation)
11. [API Endpoints](#11-api-endpoints)
12. [Data Model](#12-data-model)
13. [Observability](#13-observability)
14. [Future Extensibility](#14-future-extensibility)
15. [Non-Functional Requirements](#15-non-functional-requirements)

---

## 1. Product Overview

### What is TradingRoom?

TradingRoom is the first vertical of the OpenClaw Village platform -- an autonomous perpetual futures (PERPS) trading operation powered by AI agents running on Cloudflare Workers with Durable Objects. Each TradingRoom coordinates a team of specialized bot instances (MolWorkers) that independently analyze markets, make AI-driven decisions, and execute trades on Hyperliquid (primary) with CCXT fallback for other exchanges.

TradingRoom is NOT a game. It is a production trading infrastructure where real capital is at risk. The name reflects its purpose: a virtual room where autonomous trading agents operate collaboratively under shared risk controls.

### Who is it for?

- **Algorithmic traders** who want to deploy autonomous PERPS trading agents without managing infrastructure.
- **Trading desks** that want to run multiple strategies across multiple markets simultaneously with AI-augmented decision making.
- **Quantitative researchers** who want to test and iterate on strategy skills in a live environment with real-time monitoring.

### Key Principles

1. **Spec-driven design** -- Everything starts from this specification. All implementation flows from these contracts.
2. **One bot per market** -- Each BotInstance focuses on a single market pair to know the best price for that market. Multiple bots in a room provide cross-market intelligence.
3. **Limit order focus** -- PERPS trading with limit orders that combine best market prices for optimal execution.
4. **AI-augmented, not AI-controlled** -- Claude provides analysis and reasoning within strategy constraints. Strategies define the rules; AI provides the judgment.
5. **Observable by default** -- Every decision, order, and state change is logged with an immutable audit trail.

---

## 2. Core Concepts

### TradingRoom (Durable Object)

The TradingRoom is a Cloudflare Durable Object that serves as the central coordinator for a group of trading bots. It replaces the current `GameRoom` implementation.

**Responsibilities:**
- Manages WebSocket connections for real-time monitoring (agent-dashboard UI and external consumers)
- Maintains a registry of all BotInstances in the room
- Aggregates bot state and broadcasts state deltas to subscribers
- Enforces room-level risk limits (total exposure, correlation limits)
- Provides a shared market data cache to reduce redundant API calls
- Handles room lifecycle: creation, configuration, activation, shutdown

**Identity:** Each TradingRoom is identified by a stable name (e.g., `"trading-room-alpha"`), resolved via `TRADING_ROOM.idFromName(roomId)`.

### BotInstance / MolWorker (Durable Object)

Each BotInstance is a Cloudflare Durable Object that runs an autonomous trading loop via the DO alarm mechanism. It is the unit of execution -- one bot per market pair.

**Responsibilities:**
- Runs a periodic tick loop (configurable interval, default 5 seconds via DO alarms)
- Fetches market data for its assigned pair via the Hyperliquid SDK
- Invokes its assigned Strategy Skill to generate a trading signal
- Passes signals through the AI reasoning layer (AiService) for validation and enrichment
- Executes risk-checked orders through the market connector
- Reports state changes to the parent TradingRoom via internal fetch calls
- Persists state to DO storage (fast) with R2 backup (durable)

**Lifecycle states** (defined in `packages/types/src/agent.ts`):

```
CREATED -> CONFIGURING -> READY -> RUNNING -> PAUSED -> STOPPED -> ARCHIVED
                                     |                     ^
                                     +------> ERROR -------+
```

**Activities within RUNNING state:**

```
IDLE -> ANALYZING -> DECIDING -> EXECUTING -> MONITORING -> COOLDOWN -> IDLE
```

### Strategy Skills

Strategy Skills are pluggable modules that analyze market data and produce trading signals. Each skill encapsulates a specific trading methodology. Skills implement the `TradingStrategy` interface and are assigned to BotInstances at configuration time.

A skill does NOT execute trades directly -- it produces a `Signal` with a recommended action, confidence level, and metadata. The bot's decision pipeline then passes this through AI reasoning and risk checks before execution.

### Market Connectors

Market connectors abstract the exchange communication layer. The primary connector is the Hyperliquid SDK (`packages/hyperliquid-sdk`). A CCXT adapter will provide fallback connectivity to other exchanges.

Each connector provides:
- Market data (prices, order books, candles, funding rates)
- Order management (place, modify, cancel)
- Position tracking (open positions, PnL, margin)
- Account info (equity, margin used, withdrawable)

---

## 3. User Stories

### Room Management

- **US-1:** As a trader, I want to create a TradingRoom and assign bots to specific market pairs so that each bot becomes an expert on its pair.
- **US-2:** As a trader, I want to start/stop individual bots within a room without affecting other bots.
- **US-3:** As a trader, I want to configure room-level risk limits (max total exposure, max daily loss) that override individual bot settings.
- **US-4:** As a trader, I want to see all my rooms and their aggregate PnL in one dashboard view.

### Bot Operations

- **US-5:** As a trader, I want to assign a strategy skill to a bot and configure its parameters (e.g., lookback period, entry threshold) before starting it.
- **US-6:** As a trader, I want to see each bot's current state, activity, and last AI thought in real-time via WebSocket.
- **US-7:** As a trader, I want to see each bot's open positions, unrealized PnL, and trade history.
- **US-8:** As a trader, I want a bot to automatically pause when risk limits are breached and alert me.

### Strategy & Execution

- **US-9:** As a trader, I want bots to use limit orders by default and place them at the best available price across connected markets.
- **US-10:** As a trader, I want the AI reasoning layer to explain WHY a trade decision was made, with full context available in the audit log.
- **US-11:** As a trader, I want to deploy different strategies on the same pair (e.g., one momentum bot and one mean reversion bot on ETH) and compare performance.
- **US-12:** As a trader, I want to see each strategy's win rate, Sharpe ratio, and max drawdown in real-time.

### Monitoring & Observability

- **US-13:** As a trader, I want a real-time activity feed showing all decisions, orders, and fills across all bots in a room.
- **US-14:** As a trader, I want an immutable audit trail of every AI decision, including the prompt, response, and whether the risk check passed.
- **US-15:** As a trader, I want the SNES-style office view to show bots moving between zones based on their current activity (e.g., at TRADING_TERMINAL when executing, at RESEARCH_DESK when analyzing).

---

## 4. System Architecture

### High-Level Architecture

```
                     +------------------------+
                     |   agent-dashboard (FE)  |
                     |   React + Vite + Pixi   |
                     +-----------+------------+
                                 |
                         WebSocket + REST
                                 |
                     +-----------v------------+
                     |     agent-api          |
                     |     (Hono on CF Workers)|
                     +-----------+------------+
                                 |
                    +------------+------------+
                    |                         |
          +---------v---------+    +----------v----------+
          |   TradingRoom DO  |    |   TradingRoom DO    |
          |   (room-alpha)    |    |   (room-beta)       |
          +---------+---------+    +----------+----------+
                    |                         |
         +----------+----------+              |
         |          |          |              |
   +-----v--+ +----v---+ +----v---+    +-----v--+
   |Bot DO   | |Bot DO  | |Bot DO  |    |Bot DO  |
   |ETH-PERP | |BTC-PERP| |SOL-PERP|    |ARB-PERP|
   +----+----+ +----+---+ +----+---+    +----+---+
        |           |           |             |
        +-----+-----+-----+-----+
              |
     +--------v--------+
     | Market Connectors|
     | +- Hyperliquid  |  (primary)
     | +- CCXT Adapter |  (fallback)
     +---------+-------+
               |
     +---------v-------+
     |  External Markets|
     |  Hyperliquid L1  |
     |  Binance, Bybit  |
     +------------------+
```

### Durable Object Coordination

```
TradingRoom DO                         BotInstance DOs
+----------------------------+         +----------------------+
| - WebSocket hub            |  fetch  | - Alarm-based loop   |
| - Bot registry             |<------->| - Strategy execution |
| - Aggregated state         |         | - Order management   |
| - Room-level risk limits   |         | - State persistence  |
| - Market data cache        |         | - AI reasoning       |
+----------------------------+         +----------------------+
```

**Communication flow:**
1. BotInstance DOs report state changes to TradingRoom DO via internal `fetch()` calls after each tick.
2. TradingRoom DO receives these updates, applies room-level risk checks, and broadcasts state deltas to WebSocket subscribers.
3. The Hono API routes incoming REST/WebSocket requests to the appropriate DO by name.

### Component Mapping to Existing Code

| Concept | Current Code | Target |
|---|---|---|
| TradingRoom DO | `GameRoom` (`apps/agent-api/src/durable-objects/GameRoom.ts`) | Rename to `TradingRoom`, add bot registry, state aggregation, protocol parsing |
| BotInstance DO | `BotInstance` (`apps/agent-api/src/durable-objects/BotInstance.ts`) | Add strategy switching, AI integration, risk checks, state reporting |
| Strategy Skills | `SimpleStrategy` (`apps/agent-api/src/skills/strategies/SimpleStrategy.ts`) | Replace with real strategies (see Section 7) |
| Market Connector | `HyperliquidClient` (`packages/hyperliquid-sdk/src/client.ts`) | Already functional; add CCXT adapter alongside |
| AI Reasoning | `AiService` (`apps/agent-api/src/ai/AiService.ts`) | Integrate into bot decision loop, add structured prompts |
| State Persistence | `StorageAdapter` (`apps/agent-api/src/storage/StorageAdapter.ts`) | Already functional; add typed state interfaces |
| WebSocket Hook | `useTradingSocket` (`apps/agent-dashboard/src/hooks/useTradingSocket.ts`) | Handle typed protocol (`FULL_STATE`, `STATE_DELTA`, `ROOM_STATE`, `TRADE_EVENT`, `PONG`) |
| API Client | `api` (`apps/agent-dashboard/src/lib/api.ts`) | Extend with room management, strategy configuration |
| Types | `packages/types/src/` | Already well-defined; extend as needed |

---

## 5. WebSocket Protocol

The WebSocket protocol defines the real-time communication between TradingRoom and connected clients (agent-dashboard UI, external monitors). The existing types in `packages/types/src/realtime.ts` form the foundation.

### Connection

Clients connect to a TradingRoom WebSocket at:

```
ws://<host>/api/room/<roomId>/ws
```

On connection, the TradingRoom sends a `FULL_STATE` message for each bot in the room, then streams `STATE_DELTA` messages as bots report changes.

### Server-to-Client Messages

Defined in `realtime.ts` as `ServerMessage`:

#### `FULL_STATE`

Sent on initial connection or reconnect. Contains the complete `AgentRealtimeState` for one bot.

```typescript
interface FullStateMessage {
  type: "FULL_STATE";
  agentId: string;
  seq: number;
  timestamp: string;
  state: AgentRealtimeState;
}
```

#### `STATE_DELTA`

Sent when any field in a bot's state changes. Contains only the changed fields.

```typescript
interface StateDeltaMessage {
  type: "STATE_DELTA";
  agentId: string;
  seq: number;
  timestamp: string;
  changes: Partial<AgentRealtimeState>;
}
```

#### `ROOM_STATE`

New message type for room-level aggregates:

```typescript
interface RoomStateMessage {
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
```

#### `TRADE_EVENT`

Real-time trade notifications:

```typescript
interface TradeEventMessage {
  type: "TRADE_EVENT";
  agentId: string;
  timestamp: string;
  event: "ORDER_PLACED" | "ORDER_FILLED" | "ORDER_CANCELLED" | "POSITION_OPENED" | "POSITION_CLOSED";
  data: Record<string, unknown>;
}
```

#### `ERROR`

Error notifications from the server.

```typescript
interface ErrorMessage {
  type: "ERROR";
  code: string;
  message: string;
}
```

#### `PONG`

Response to client `PING`.

### Client-to-Server Messages

Defined in `realtime.ts` as `ClientMessage`:

#### `SUBSCRIBE`

Subscribe to updates for a specific bot:

```typescript
interface SubscribeMessage {
  type: "SUBSCRIBE";
  agentId: string;
}
```

#### `UNSUBSCRIBE`

Unsubscribe from a bot's updates:

```typescript
interface UnsubscribeMessage {
  type: "UNSUBSCRIBE";
  agentId: string;
}
```

#### `PING`

Keepalive heartbeat:

```typescript
interface PingMessage {
  type: "PING";
}
```

### Sequence Numbers

Each `FULL_STATE` and `STATE_DELTA` message carries a monotonically increasing `seq` number per agent. Clients use this to detect missed messages. If a client detects a gap in sequence numbers, it should request a full state resync by disconnecting and reconnecting (or by sending a future `RESYNC` command).

### AgentRealtimeState

The complete real-time state for a bot (defined in `realtime.ts`):

```typescript
interface AgentRealtimeState {
  agentId: string;
  state: AgentState;         // CREATED | CONFIGURING | READY | RUNNING | ...
  activity: AgentActivity;   // IDLE | ANALYZING | DECIDING | EXECUTING | ...
  currentThought: string | null;
  positions: Position[];
  pnlTotal: number;
  pnlToday: number;
  tradeCountToday: number;
  lastTradeAt: string | null;
  visualPosition: {
    x: number;
    y: number;
    zone: VisualZone;        // BREAK_ROOM | RESEARCH_DESK | TRADING_TERMINAL | ...
    animation: string;
  };
}
```

---

## 6. Trading Flow

Each BotInstance tick follows this pipeline:

```
+---------------+     +--------------+     +----------------+     +-------------+     +------------------+     +-------------------+
| 1. Market     | --> | 2. Strategy  | --> | 3. AI          | --> | 4. Risk     | --> | 5. Order         | --> | 6. Position       |
|    Data Fetch |     |    Analysis  |     |    Reasoning   |     |    Check    |     |    Execution     |     |    Monitoring     |
+---------------+     +--------------+     +----------------+     +-------------+     +------------------+     +-------------------+
     ANALYZING              ANALYZING           DECIDING            DECIDING            EXECUTING                MONITORING
```

### Step 1: Market Data Fetch

**Activity:** `ANALYZING`

The bot fetches current market data for its assigned pair via the Hyperliquid SDK:

```typescript
// Fetch from Hyperliquid SDK
const ticker = await client.getTicker(pair);           // Mid price
const orderBook = await client.getOrderBook(pair);     // L2 book
const candles = await client.getCandles(pair, "5m", startTime, endTime);
const fundingRates = await client.getFundingRates();   // Predicted funding
const recentTrades = await client.getRecentTrades(pair);
```

This data is assembled into a `MarketData` snapshot (defined in `packages/types/src/trading.ts`).

### Step 2: Strategy Analysis

**Activity:** `ANALYZING`

The assigned Strategy Skill processes the market data and produces a `Signal`:

```typescript
interface Signal {
  skillName: string;        // e.g., "MOMENTUM_SCALPER"
  action: TradeAction;      // OPEN_LONG | OPEN_SHORT | CLOSE | HOLD | ADJUST
  pair: string;
  confidence: number;       // 0-100
  metadata: Record<string, unknown>;  // Strategy-specific data
  timestamp: string;
}
```

If the signal action is `HOLD` with confidence below the strategy threshold, the pipeline short-circuits and the bot enters `COOLDOWN`.

### Step 3: AI Reasoning

**Activity:** `DECIDING`

For non-HOLD signals, the bot invokes the AiService (Claude via CF AI Gateway) to validate and enrich the strategy signal:

```typescript
const aiPrompt = buildDecisionPrompt({
  signal,
  marketData,
  positions: currentPositions,
  riskConfig: botConfig.risk,
  recentDecisions: last5Decisions,
});

const aiResponse = await aiService.generate(aiPrompt, TRADING_SYSTEM_PROMPT);
const decision: TradeDecision = parseDecisionResponse(aiResponse);
```

The AI receives:
- The strategy signal with metadata
- Current market snapshot (price, order book depth, funding rate, volume)
- Current open positions and unrealized PnL
- Risk configuration constraints
- Recent decision history (to avoid flip-flopping)

The AI returns a structured `TradeDecision` (defined in `packages/types/src/trading.ts`):

```typescript
interface TradeDecision {
  action: TradeAction;
  pair: string;
  size: number;
  leverage: number;
  orderType: OrderType;
  limitPrice?: number;
  stopLoss: number;
  takeProfit: number;
  rationale: string;       // Human-readable explanation
  confidence: number;      // 0-100
}
```

### Step 4: Risk Check

**Activity:** `DECIDING`

The decision passes through risk validation against the bot's `RiskConfig` (defined in `packages/types/src/agent.ts`):

```typescript
interface RiskConfig {
  maxDrawdownPct: number;          // e.g., 10 = 10% max drawdown
  maxDailyLossUsd: number;         // e.g., 500 = $500 max daily loss
  maxSingleTradeLossUsd: number;   // e.g., 100 = $100 max per trade
  stopLossRequired: boolean;       // Must have a stop-loss
  forceStopOnDrawdown: boolean;    // Auto-stop bot on drawdown breach
}
```

**Risk checks performed:**
1. **Position sizing:** Does the proposed position size exceed `maxPositionSizeUsd`?
2. **Leverage:** Does the proposed leverage exceed `maxLeverage`?
3. **Concurrent positions:** Would this exceed `maxConcurrentPositions`?
4. **Stop-loss present:** If `stopLossRequired`, does the decision include a stop-loss?
5. **Single trade risk:** Is the potential loss (based on stop-loss distance) within `maxSingleTradeLossUsd`?
6. **Daily loss limit:** Has `maxDailyLossUsd` already been reached?
7. **Drawdown check:** Has `maxDrawdownPct` been breached?

If any check fails:
- The decision is logged with `riskCheckPassed: false` and the specific reason.
- If `forceStopOnDrawdown` is true and drawdown is breached, the bot transitions to `ERROR` state.
- Otherwise, the bot enters `COOLDOWN` and waits for the next tick.

### Step 5: Order Execution

**Activity:** `EXECUTING`

Risk-approved decisions are executed via the Hyperliquid SDK:

```typescript
// Set leverage for the pair
await client.updateLeverage(pair, decision.leverage, true);

// Place the limit order
const orderResult = await client.placeOrder({
  coin: pair,
  isBuy: decision.action === "OPEN_LONG",
  price: decision.limitPrice ?? midPrice,
  size: decision.size,
  orderType: "limit",
  timeInForce: "Gtc",
});

// Place stop-loss trigger
await client.placeTriggerOrder({
  coin: pair,
  isBuy: decision.action !== "OPEN_LONG",  // Opposite side
  size: decision.size,
  triggerPrice: decision.stopLoss,
  isMarket: true,
  tpsl: "sl",
});

// Place take-profit trigger
await client.placeTriggerOrder({
  coin: pair,
  isBuy: decision.action !== "OPEN_LONG",
  size: decision.size,
  triggerPrice: decision.takeProfit,
  isMarket: true,
  tpsl: "tp",
});
```

### Step 6: Position Monitoring

**Activity:** `MONITORING`

After order placement, the bot monitors the position:
- Checks if the order was filled, partially filled, or resting.
- Updates internal position state.
- Reports the trade event to the parent TradingRoom.
- Logs the complete decision cycle (market context, prompt, AI response, risk check, order result).
- Transitions to `COOLDOWN` before the next tick.

### Complete Tick Pseudocode

```
alarm() {
  activity = ANALYZING
  marketData = fetchMarketData(pair)

  activity = ANALYZING
  signal = strategy.analyze(marketData)

  if signal.action == HOLD {
    log(decision: HOLD)
    reportToRoom(state)
    scheduleNext()
    return
  }

  activity = DECIDING
  decision = ai.reason(signal, marketData, positions, riskConfig)

  activity = DECIDING
  riskResult = riskCheck(decision, riskConfig, currentState)

  if !riskResult.passed {
    log(decision, riskResult)
    if riskResult.critical { state = ERROR; return }
    reportToRoom(state)
    scheduleNext()
    return
  }

  activity = EXECUTING
  orderResult = execute(decision)
  log(decision, orderResult)

  activity = MONITORING
  updatePositions()
  reportToRoom(state)

  activity = COOLDOWN
  scheduleNext()
}
```

---

## 7. Strategy Skills

Each Strategy Skill implements the `TradingStrategy` interface (defined in `apps/agent-api/src/skills/TradingStrategy.ts`). The current `SimpleStrategy` (random BUY/HOLD) must be replaced with production strategies.

### Strategy Interface

```typescript
interface TradingStrategy {
  name: string;
  analyze(client: HyperliquidClient): Promise<StrategyDecision>;
}
```

**Proposed enhanced interface:**

```typescript
interface TradingStrategy {
  name: string;
  type: StrategyType;
  defaultParams: Record<string, unknown>;

  initialize(params: Record<string, unknown>): void;
  analyze(marketData: MarketData, candles: Candle[], positions: Position[]): Promise<Signal>;
  getState(): Record<string, unknown>;  // For observability
}
```

### Strategy Catalog

#### 1. Momentum Scalper (`MOMENTUM_SCALPER`)

**Description:** Identifies short-term momentum bursts and scalps quick entries on PERPS with tight stop-losses.

**Parameters:**
- `lookbackPeriod`: Number of candles to analyze (default: 20)
- `momentumThreshold`: Minimum momentum score to trigger entry (default: 0.7)
- `volumeMultiplier`: Volume must exceed N x average to confirm momentum (default: 1.5)
- `takeProfitPct`: Take profit distance as percentage (default: 0.5%)
- `stopLossPct`: Stop loss distance as percentage (default: 0.25%)

**Signal Logic:**
1. Calculate momentum via rate of change (ROC) over lookback period.
2. Confirm with above-average volume.
3. Check for alignment with higher timeframe trend (15m candles).
4. If momentum is bullish and confirmed, signal OPEN_LONG. If bearish, OPEN_SHORT.
5. Confidence is proportional to momentum strength and volume confirmation.

#### 2. Mean Reversion (`MEAN_REVERSION`)

**Description:** Detects overbought/oversold conditions using Bollinger Bands and RSI, entering positions against the extreme with the expectation of mean reversion.

**Parameters:**
- `bollingerPeriod`: Bollinger Band period (default: 20)
- `bollingerStdDev`: Standard deviations (default: 2.0)
- `rsiPeriod`: RSI calculation period (default: 14)
- `rsiOverbought`: RSI threshold for overbought (default: 70)
- `rsiOversold`: RSI threshold for oversold (default: 30)
- `maxHoldPeriod`: Maximum ticks to hold a mean reversion position (default: 60)

**Signal Logic:**
1. Calculate Bollinger Bands and RSI.
2. If price touches lower band AND RSI < oversold threshold, signal OPEN_LONG.
3. If price touches upper band AND RSI > overbought threshold, signal OPEN_SHORT.
4. Confidence increases when both indicators strongly confirm the extreme.

#### 3. Breakout Hunter (`BREAKOUT_HUNTER`)

**Description:** Monitors key support/resistance levels and enters on confirmed breakouts with volume expansion.

**Parameters:**
- `lookbackPeriod`: Candles to scan for support/resistance (default: 100)
- `breakoutConfirmCandles`: Number of candles above/below level to confirm (default: 3)
- `volumeBreakoutMultiplier`: Volume threshold for breakout confirmation (default: 2.0)
- `falseBreakoutFilter`: Use order book depth to filter false breakouts (default: true)

**Signal Logic:**
1. Identify horizontal support/resistance from price pivots over lookback period.
2. Watch for price crossing a key level.
3. Confirm with volume expansion and order book analysis (thin book above resistance = likely breakout).
4. Signal OPEN_LONG on resistance breakout, OPEN_SHORT on support breakdown.
5. Confidence based on level significance, volume confirmation, and order book.

#### 4. Grid Trader (`GRID_TRADER`)

**Description:** Places a grid of limit orders above and below current price, profiting from range-bound markets.

**Parameters:**
- `gridLevels`: Number of grid levels above and below (default: 5)
- `gridSpacing`: Percentage spacing between levels (default: 0.3%)
- `orderSizeUsd`: Size per grid order in USD (default: 50)
- `rebalanceThreshold`: Price deviation from center to rebalance grid (default: 3%)

**Signal Logic:**
1. Calculate grid levels based on current mid price and spacing.
2. Check existing open orders against desired grid.
3. Signal ADJUST to add missing levels or cancel stale ones.
4. If price has moved beyond the rebalance threshold, signal grid recenter.
5. Confidence is always moderate (grid trading is mechanical, not directional).

#### 5. Funding Rate Arbitrage (`FUNDING_RATE_ARB`)

**Description:** Exploits extreme funding rates by taking positions opposite to the funding direction, collecting funding payments while hedging directional risk.

**Parameters:**
- `fundingThreshold`: Minimum absolute funding rate to trigger (default: 0.01% per 8h)
- `minHoldHours`: Minimum hold time to collect funding (default: 8)
- `maxPositionPct`: Max position size as percentage of equity (default: 10%)
- `hedgeEnabled`: Whether to hedge on a secondary exchange (default: false)

**Signal Logic:**
1. Fetch predicted funding rates from Hyperliquid.
2. If funding is extremely positive (longs pay shorts), signal OPEN_SHORT to collect.
3. If funding is extremely negative (shorts pay longs), signal OPEN_LONG to collect.
4. Confidence based on funding rate magnitude and historical stability.
5. When hedging is enabled, signal includes a hedge order on the CCXT-connected exchange.

---

## 8. Risk Management

Risk management operates at two levels: **bot-level** and **room-level**.

### Bot-Level Risk (per BotInstance)

Configured via `RiskConfig` in the bot's `AgentConfig`:

| Parameter | Type | Description |
|---|---|---|
| `maxDrawdownPct` | number | Maximum drawdown from equity peak before forced stop (e.g., 10 = 10%) |
| `maxDailyLossUsd` | number | Maximum cumulative loss in a 24h window |
| `maxSingleTradeLossUsd` | number | Maximum potential loss on any single trade (based on stop-loss distance) |
| `stopLossRequired` | boolean | Reject any decision without a stop-loss |
| `forceStopOnDrawdown` | boolean | Automatically transition bot to ERROR state on drawdown breach |

**Additional bot-level limits** from `TradingConfig`:

| Parameter | Type | Description |
|---|---|---|
| `maxLeverage` | number | Maximum leverage allowed |
| `maxPositionSizeUsd` | number | Maximum position size in USD |
| `maxConcurrentPositions` | number | Maximum number of open positions simultaneously |

### Room-Level Risk (per TradingRoom)

The TradingRoom enforces aggregate limits across all bots:

| Parameter | Type | Description |
|---|---|---|
| `maxTotalExposureUsd` | number | Maximum combined notional exposure across all bots |
| `maxDailyRoomLossUsd` | number | Maximum combined daily loss before all bots pause |
| `maxCorrelation` | number | Maximum allowed correlation between bot positions (avoid concentrated risk) |
| `emergencyShutdown` | boolean | Kill switch to immediately stop all bots and cancel all orders |

### Risk Check Flow

```
Trade Decision
      |
      v
  [Bot-Level Checks]
  - Position size <= maxPositionSizeUsd?
  - Leverage <= maxLeverage?
  - Concurrent positions <= maxConcurrentPositions?
  - Stop-loss present (if required)?
  - Potential loss <= maxSingleTradeLossUsd?
  - Daily loss still within maxDailyLossUsd?
  - Drawdown still within maxDrawdownPct?
      |
      v (if all pass)
  [Room-Level Checks]
  - Total exposure + new position <= maxTotalExposureUsd?
  - Room daily loss still within maxDailyRoomLossUsd?
  - Position not too correlated with existing positions?
      |
      v (if all pass)
  APPROVED -> Execute
```

### Circuit Breakers

- **Drawdown circuit breaker:** If a bot hits `maxDrawdownPct`, it transitions to `ERROR` state (if `forceStopOnDrawdown` is true) or `PAUSED` state. All open orders are cancelled. Positions remain open (manual intervention required).
- **Daily loss circuit breaker:** If the room hits `maxDailyRoomLossUsd`, ALL bots in the room are paused. Resumes at UTC midnight or on manual override.
- **Emergency shutdown:** The TradingRoom supports an `emergencyShutdown` command that immediately stops all bots, cancels all open orders, and optionally closes all positions at market.

---

## 9. Multi-Market Support

### Primary: Hyperliquid

The `@repo/hyperliquid-sdk` package provides full Hyperliquid integration:

**Market Data:**
- `getMeta()` -- Asset metadata (symbols, decimals, max leverage)
- `getAllMids()` -- Current mid prices for all assets
- `getOrderBook(coin)` -- L2 order book
- `getRecentTrades(coin)` -- Recent trades
- `getCandles(coin, interval, start, end)` -- OHLCV candles
- `getFundingRates()` -- Predicted funding rates
- `getFundingHistory(coin, start, end)` -- Historical funding

**Account & Positions:**
- `getAccountInfo()` -- Equity, margin, positions
- `getPositions()` -- Parsed open positions
- `getOpenOrders()` -- Current open orders

**Order Management:**
- `placeOrder(params)` -- Place limit/market orders (batch supported, max 20)
- `placeTriggerOrder(params)` -- Stop-loss / take-profit triggers
- `cancelOrder(params)` -- Cancel by order ID
- `modifyOrder(params)` -- Atomic cancel + replace
- `closePosition(params)` -- Close fully or partially
- `updateLeverage(coin, leverage, isCross)` -- Set leverage

**Infrastructure:**
- Token-bucket rate limiter (CF Workers compatible, no timers)
- EIP-712 signature auth via viem (no Node.js dependencies)
- Asset index caching for efficient order wire construction

### Fallback: CCXT Adapter

For exchanges not natively supported, a CCXT adapter will provide a unified interface. The adapter maps the common `TradingStrategy` output to CCXT's order interface.

**Supported exchanges (via CCXT):**
- Binance Futures
- Bybit USDT Perpetuals
- OKX Perpetual Swaps

**Adapter interface:**

```typescript
interface MarketConnector {
  name: string;
  exchange: string;

  // Market data
  getTicker(pair: string): Promise<Ticker>;
  getOrderBook(pair: string, depth?: number): Promise<OrderBook>;
  getCandles(pair: string, interval: string, limit?: number): Promise<Candle[]>;

  // Account
  getBalance(): Promise<Balance>;
  getPositions(): Promise<Position[]>;

  // Orders
  placeOrder(params: PlaceOrderParams): Promise<OrderResult>;
  cancelOrder(orderId: string, pair: string): Promise<void>;

  // Metadata
  getSupportedPairs(): Promise<string[]>;
  getMaxLeverage(pair: string): Promise<number>;
}
```

### Connector Registry

Bots specify which connector to use in their configuration:

```typescript
interface BotConnectorConfig {
  primary: {
    connector: "hyperliquid";
    config: HyperliquidConfig;
  };
  fallback?: {
    connector: "ccxt";
    exchange: "binance" | "bybit" | "okx";
    config: CCXTConfig;
  };
}
```

---

## 10. Best Price Aggregation

A key differentiator of TradingRoom is that multiple bots in a room -- each focused on a single market -- collectively build a real-time picture of best prices across venues.

### Architecture

```
Bot A (ETH on Hyperliquid) ---+
                               |
Bot B (ETH on Binance)    ----+---> Price Aggregator ---> Best Execution
                               |
Bot C (ETH on Bybit)     ----+
```

### Price Aggregator Service

The TradingRoom maintains a shared `PriceAggregator` that collects price snapshots from all bots:

```typescript
interface PriceSnapshot {
  pair: string;
  exchange: string;
  bid: number;
  ask: number;
  midPrice: number;
  timestamp: string;
  depth: number;  // Available liquidity at best price
}

interface BestPrice {
  pair: string;
  bestBid: PriceSnapshot;   // Highest bid across venues
  bestAsk: PriceSnapshot;   // Lowest ask across venues
  spread: number;            // Best bid to best ask spread
  venues: PriceSnapshot[];   // All venue prices
}
```

### Best Execution Flow

1. Bots report their market data to the TradingRoom after each tick.
2. The TradingRoom's PriceAggregator maintains a real-time best-price table.
3. When a bot wants to execute a trade, it queries the aggregator for the best venue.
4. The order is routed to the venue with the best price and sufficient liquidity.
5. If the best venue is not the bot's primary connector, the TradingRoom delegates execution to the bot that owns that venue's connector.

### Smart Order Routing

```typescript
interface SmartOrderRouting {
  pair: string;
  action: "BUY" | "SELL";
  size: number;

  // Choose execution venue
  selectVenue(prices: BestPrice): {
    venue: string;
    price: number;
    expectedSlippage: number;
  };
}
```

For the initial implementation, each bot executes on its own connector. Cross-venue execution is a future enhancement.

---

## 11. API Endpoints

The Hono API (`apps/agent-api/src/index.ts`) exposes REST endpoints for management and a WebSocket endpoint for real-time updates.

### System

| Method | Path | Description |
|---|---|---|
| `GET` | `/` | Service health check |
| `GET` | `/api/status` | System status (version, timestamp) |

### Room Management

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/room` | Create a new TradingRoom |
| `GET` | `/api/room/:id/info` | Get room configuration, registry, and room metrics |
| `POST` | `/api/room/:id/emergency-stop` | Emergency shutdown: stop all registered bots and return per-bot results |

### Bot Management

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/room/:roomId/bot` | Create and register a bot in a room |
| `POST` | `/api/room/:roomId/bot/:id/start` | Start bot by room-scoped id/alias (injects room context) |
| `POST` | `/api/room/:roomId/bot/:id/stop` | Stop bot by room-scoped id/alias |
| `POST` | `/api/room/:roomId/bot/:id/pause` | Pause bot by room-scoped id/alias |
| `GET` | `/api/room/:roomId/bot/:id/status` | Get bot status by room-scoped id/alias |
| `GET` | `/api/room/:roomId/bot/:id/logs` | Get recent bot logs by room-scoped id/alias |
| `GET` | `/api/room/:roomId/bot/:id/positions` | Get positions by room-scoped id/alias |
| `GET` | `/api/room/:roomId/bot/:id/pnl` | Get PnL by room-scoped id/alias |
| `PUT` | `/api/room/:roomId/bot/:id/config` | Update bot config by room-scoped id/alias |
| `GET` | `/api/bot/:id/status` | Get bot status (state, activity, uptime, ticks, errors) |
| `POST` | `/api/bot/:id/start` | Start the bot's trading loop |
| `POST` | `/api/bot/:id/stop` | Stop the bot's trading loop |
| `POST` | `/api/bot/:id/pause` | Pause the bot (keep state, stop ticking) |
| `PUT` | `/api/bot/:id/config` | Update bot configuration (strategy, risk, trading params) |
| `GET` | `/api/bot/:id/logs` | Get recent decision/trade logs |
| `GET` | `/api/bot/:id/positions` | Get current open positions |
| `GET` | `/api/bot/:id/pnl` | Get PnL summary (total, daily, per-trade) |

### WebSocket

| Path | Description |
|---|---|
| `GET` | `/api/room/:id/ws` | WebSocket upgrade. On connect, receives `FULL_STATE` for all room bots, then streams `STATE_DELTA`, `TRADE_EVENT`, and `ROOM_STATE` messages. |

### Authentication

All `/api/*` routes and WS upgrade paths require shared-secret auth (`OPENCLAW_GATEWAY_PASSWORD`) via:

- `x-openclaw-gateway-password` header, or
- `Authorization: Bearer <password>`, or
- `gateway_password` query param (WS/browser clients).

### Example: Create a Room with Bots

```bash
# Create room
POST /api/room
{
  "name": "Alpha Trading Desk",
  "risk": {
    "maxTotalExposureUsd": 50000,
    "maxDailyRoomLossUsd": 2000
  }
}

# Add ETH bot with Momentum Scalper
POST /api/room/alpha-desk/bot
{
  "name": "ETH Momentum",
  "config": {
    "strategy": {
      "type": "MOMENTUM_SCALPER",
      "params": { "lookbackPeriod": 20, "momentumThreshold": 0.7 }
    },
    "trading": {
      "pairs": ["ETH"],
      "maxLeverage": 5,
      "maxPositionSizeUsd": 5000,
      "maxConcurrentPositions": 1,
      "orderTypes": ["LIMIT", "STOP_LOSS", "TAKE_PROFIT"]
    },
    "risk": {
      "maxDrawdownPct": 5,
      "maxDailyLossUsd": 200,
      "maxSingleTradeLossUsd": 50,
      "stopLossRequired": true,
      "forceStopOnDrawdown": true
    },
    "reasoning": {
      "model": "claude-3-5-sonnet-20240620",
      "intervalSeconds": 10,
      "temperature": 0.3,
      "maxTokens": 512
    }
  }
}

# Start the bot
POST /api/bot/eth-momentum/start
```

---

## 12. Data Model

### State Persistence Strategy

State is persisted using a two-tier approach leveraging Cloudflare's infrastructure:

#### Tier 1: Durable Object Storage (fast, co-located)

Each DO has access to `ctx.storage` -- a transactional key-value store co-located with the DO instance. This is the primary read/write layer for all hot state.

**BotInstance DO storage keys:**

| Key | Type | Description |
|---|---|---|
| `botState` | `BotState` | Core bot state (isRunning, tickCount, errors, etc.) |
| `agentConfig` | `AgentConfig` | Full configuration including strategy, risk, trading params |
| `positions` | `Position[]` | Current open positions |
| `pnlSummary` | `PnlSummary` | Cumulative PnL metrics |
| `recentLogs` | `LogEntry[]` | Last 50 log entries (ring buffer) |
| `recentDecisions` | `TradeDecision[]` | Last 10 decisions (for AI context) |
| `dailyMetrics` | `DailyMetrics` | Today's PnL, trade count, max drawdown |

**TradingRoom DO storage keys:**

| Key | Type | Description |
|---|---|---|
| `roomConfig` | `RoomConfig` | Room name, risk limits, creation metadata |
| `botRegistry` | `BotRegistryEntry[]` | List of registered bots with their DO IDs |
| `roomMetrics` | `RoomMetrics` | Aggregated PnL, exposure, risk status |
| `priceCache` | `Map<string, PriceSnapshot>` | Shared market data cache |

#### Tier 2: R2 Object Storage (durable, archival)

R2 provides cheap, durable storage for historical data, audit trails, and disaster recovery.

**R2 bucket structure** (`OPENCLAW_DATA`):

```
openclaw-village-data/
  rooms/
    {roomId}/
      config.json                    # Room configuration snapshot
      metrics/
        {date}.json                  # Daily aggregated metrics
  bots/
    {botId}/
      config.json                    # Bot configuration snapshot
      state.json                     # Latest state backup
      logs/
        {timestamp}.json             # Individual log entries
      decisions/
        {date}/
          {timestamp}.json           # AI decision audit trail
      metrics/
        {date}.json                  # Daily PnL and performance
```

#### Recovery Flow

1. On DO startup, load state from `ctx.storage`.
2. If `ctx.storage` is empty (DO was evicted or migrated), fall back to R2.
3. R2 backup is written asynchronously via `ctx.waitUntil()` after each state change.

This is already implemented in `StorageAdapter` (`apps/agent-api/src/storage/StorageAdapter.ts`).

---

## 13. Observability

### Logging

Every meaningful event in the system is logged via the `LogEntry` type (defined in `packages/types/src/logs.ts`).

**Log types:**

| Type | When | Data |
|---|---|---|
| `DECISION` | After AI reasoning completes | Market context, prompt, response, decision, risk check result, duration |
| `ORDER` | When an order is placed | Order ID, pair, side, type, size, price, status |
| `FILL` | When an order is filled | Order ID, pair, filled size, average price, fee |
| `STATE_CHANGE` | When bot state transitions | From state, to state, reason |
| `ERROR` | On any error | Error code, message, stack trace, context |
| `SYSTEM` | System events | Event name, details |

### Audit Trail

Decision logs include a `prevHash` field that creates a hash chain:

```
LogEntry[n].prevHash = hash(LogEntry[n-1])
```

This provides a tamper-evident audit trail. Any modification to a historical log entry would break the hash chain.

### Performance Metrics

Each bot tracks and exposes:

- **Trade metrics:** Win rate, avg win, avg loss, profit factor, Sharpe ratio
- **Timing metrics:** Avg tick duration, AI reasoning latency, order placement latency
- **Risk metrics:** Current drawdown, daily PnL, margin utilization
- **Strategy metrics:** Signal frequency, confidence distribution, hit rate by confidence bucket

### Cloudflare Observability

The wrangler configuration already enables CF observability:

```toml
[observability]
enabled = true
```

This provides:
- `console.log` / `console.error` captured in CF dashboard
- DO analytics (requests, duration, storage operations)
- Worker analytics (invocations, errors, duration percentiles)

### Mission Control Dashboard

The agent-dashboard frontend provides visual observability:

- **Office View:** SNES-style pixel art showing bot agents at their stations, moving between zones (RESEARCH_DESK, TRADING_TERMINAL, BREAK_ROOM) based on their `AgentActivity`.
- **Bot Cards:** Real-time status, tick count, uptime, start/stop controls.
- **Activity Feed:** Scrolling log of decisions and trades across all bots.
- **PnL Dashboard:** Total and per-bot PnL with charts (future).

---

## 14. Future Extensibility

### Room Types

TradingRoom is the first "room type" in the OpenClaw Village platform. The architecture supports additional room types for different verticals:

```
Room (base)
  |
  +-- TradingRoom      (v1 - this spec)
  |     PERPS trading agents
  |
  +-- SocialRoom        (future)
  |     Community management bots
  |     Twitter/Discord/Telegram automation
  |
  +-- ResearchRoom      (future)
  |     Market research and alpha generation
  |     Data aggregation and analysis
  |
  +-- CustomRoom        (future)
        User-defined mini-businesses
        Custom skills and integrations
```

Each room type shares:
- The Durable Object infrastructure (Cloudflare Workers + DO)
- WebSocket real-time protocol
- Bot lifecycle management (CREATED -> RUNNING -> STOPPED)
- Observability and logging framework
- The agent-dashboard UI shell (with room-specific views)

Each room type customizes:
- Skill catalog (trading skills vs. social skills vs. research skills)
- State shape (positions vs. engagement metrics vs. research data)
- Risk management (financial risk vs. rate limits vs. data quality)
- External integrations (exchanges vs. social APIs vs. data providers)

### Skill Marketplace

As the platform grows, Strategy Skills could become a marketplace:
- Users publish custom skills.
- Skills are sandboxed and audited.
- Revenue sharing on profitable strategies.

### Multi-Tenant Support

Each TradingRoom is already isolated via Durable Objects. Multi-tenant support requires:
- Authentication and authorization (API keys or wallet signatures).
- Per-tenant resource quotas.
- Billing integration.

---

## 15. Non-Functional Requirements

### Latency

| Operation | Target | Notes |
|---|---|---|
| Market data fetch (Hyperliquid) | < 200ms | SDK rate limiter manages throughput |
| Strategy analysis | < 50ms | Pure computation, no I/O |
| AI reasoning (Claude via CF Gateway) | < 2000ms | Dependent on CF AI Gateway latency |
| Risk check | < 10ms | In-memory computation |
| Order placement (Hyperliquid) | < 500ms | Including signature generation |
| WebSocket broadcast | < 50ms | DO-local fan-out |
| **Total tick latency** | **< 3000ms** | End-to-end for one decision cycle |
| Bot tick interval | 5000ms (default) | Configurable via `reasoning.intervalSeconds` |

### Reliability

- **DO persistence:** Durable Object storage is transactional and durable. State survives DO eviction.
- **R2 backup:** Asynchronous backup ensures data survives even DO migration or reset.
- **Auto-reconnect:** WebSocket clients (agent-dashboard) auto-reconnect with 3-second backoff (already implemented in `useTradingSocket`).
- **Error recovery:** Bots track error counts. After N consecutive errors, bot transitions to `ERROR` state to prevent runaway failures.
- **Alarm reliability:** CF DO alarms are guaranteed to fire. If a tick fails, the next alarm still fires.

### Security

- **Private key isolation:** `HL_PRIVATE_KEY` is stored in CF Worker secrets, never in code or R2.
- **AI Gateway:** Claude API calls go through Cloudflare AI Gateway (`CF_AI_GATEWAY_*`), providing rate limiting, caching, and audit logging at the gateway level.
- **Shared-secret auth:** All `/api/*` and WS upgrade paths require `OPENCLAW_GATEWAY_PASSWORD`.
- **CORS:** Configured in Hono middleware for allowed origins and auth headers.
- **No client-side trading:** All trade execution happens server-side in DO. The frontend is read-only (start/stop are management commands, not trade commands).
- **EIP-712 signatures:** All Hyperliquid exchange requests are signed with EIP-712 via viem, ensuring only the configured wallet can execute trades.

### Scalability

- **Horizontal scaling:** Each TradingRoom and BotInstance is an independent Durable Object. Cloudflare automatically distributes DOs across their global network.
- **No shared state bottleneck:** DOs communicate via fetch, not shared memory. Each DO scales independently.
- **Rate limiter:** The Hyperliquid SDK includes a token-bucket rate limiter compatible with CF Workers (no timers/intervals needed).
- **R2 write batching:** Log writes to R2 use `ctx.waitUntil()` for fire-and-forget async persistence.

### Limits

| Resource | Limit | Notes |
|---|---|---|
| Bots per room | 20 | Practical limit based on WebSocket broadcast overhead |
| Rooms per account | 10 | Prevent resource exhaustion |
| Orders per batch | 20 | Hyperliquid API limit |
| WebSocket subscriptions | 100 per connection | Hyperliquid SDK constant |
| R2 log retention | 90 days | Configurable; older logs archived or deleted |
| DO storage per instance | 128 KB recommended | Keep hot state minimal; overflow to R2 |

---

## Appendix A: Existing Type References

The following types are already defined in `packages/types/src/` and form the canonical data model:

- `AgentState`, `AgentActivity`, `StrategyType` -- `agent.ts`
- `AgentConfig`, `StrategyConfig`, `TradingConfig`, `RiskConfig`, `ReasoningConfig` -- `agent.ts`
- `Agent`, `OrderType`, `TradeSide`, `TradeAction` -- `agent.ts`
- `TradeDecision`, `Position`, `Order`, `OrderStatus`, `PnlSummary` -- `trading.ts`
- `MarketData`, `OrderBookSnapshot`, `Candle`, `Signal` -- `trading.ts`
- `ServerMessage`, `ClientMessage`, `StateDeltaMessage`, `FullStateMessage` -- `realtime.ts`
- `AgentRealtimeState`, `VisualZone` -- `realtime.ts`
- `LogEntry`, `LogType`, `LogData`, `DecisionLogData`, `OrderLogData` -- `logs.ts`

## Appendix B: Wrangler Configuration Changes

Current `wrangler.toml` needs these changes:

```toml
# Rename GameRoom to TradingRoom
[[durable_objects.bindings]]
name = "TRADING_ROOM"          # was: GAME_ROOM
class_name = "TradingRoom"     # was: GameRoom

[[durable_objects.bindings]]
name = "BOT_INSTANCE"
class_name = "BotInstance"

# Migration to rename the class
[[migrations]]
tag = "v2"
renamed_classes = [{from = "GameRoom", to = "TradingRoom"}]
```

## Appendix C: Environment Variables

```
# Cloudflare AI Gateway
CF_AI_GATEWAY_ACCOUNT_ID         # Cloudflare account ID
CF_AI_GATEWAY_ID         # AI Gateway ID
CF_AIG_AUTH_TOKEN                # Authenticated Gateway token (recommended)
CF_AI_DEFAULT_MODEL              # Optional default model (e.g. anthropic/claude-opus-4-6)

# Hyperliquid
HL_PRIVATE_KEY                   # Wallet private key (secret)
HYPERLIQUID_TESTNET              # "true" for testnet, omit for mainnet

# Bindings (auto-configured via wrangler.toml)
TRADING_ROOM                     # Durable Object binding
BOT_INSTANCE                     # Durable Object binding
OPENCLAW_DATA                    # R2 bucket binding
AI                               # CF AI binding
```
