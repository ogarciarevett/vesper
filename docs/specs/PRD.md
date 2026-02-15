# Tenacitas Trading Floor -- Product Requirements Document

**Version:** 1.0
**Date:** 2026-02-14
**Status:** Draft
**Author:** Product Agent

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Problem Statement](#2-problem-statement)
3. [User Personas](#3-user-personas)
4. [Phase 1 -- Engine & Execution (Core)](#4-phase-1--engine--execution-core)
5. [Phase 2 -- Orchestration (Durable Objects)](#5-phase-2--orchestration-durable-objects)
6. [Phase 3 -- Visual Interface (React + Phaser.js)](#6-phase-3--visual-interface-react--phaserjs)
7. [Phase 4 -- Marketplace & Rental](#7-phase-4--marketplace--rental)
8. [Non-Functional Requirements](#8-non-functional-requirements)
9. [Architecture Overview](#9-architecture-overview)
10. [Open Questions & Risks](#10-open-questions--risks)

---

## 1. Executive Summary

Tenacitas Trading Floor is a multi-tenant SaaS platform where autonomous AI agents -- powered by Claude -- execute perpetual futures trades on Hyperliquid. Each agent is represented as a pixel-art avatar on a visual trading floor rendered with Phaser.js. Users can deploy, configure, monitor, and rent trading agents through a real-time interactive interface.

The platform bridges the gap between opaque algorithmic trading and transparent, observable AI decision-making. By visualizing agent behavior in a virtual office metaphor, users gain intuitive understanding of what their agents are doing and why.

The product is built entirely on the Cloudflare Workers ecosystem (Workers, Durable Objects, R2, D1, KV, Pages, AI Gateway) with a Turborepo + Bun monorepo, Hono for the API layer, and React + Vite + Phaser.js for the frontend.

### Success Metrics

| Metric | Phase 1 Target | Phase 4 Target |
|---|---|---|
| Agents running concurrently | 50 | 1,000+ |
| Order execution latency (p99) | <100ms | <50ms |
| Agent uptime | 99% | 99.9% |
| Mean time to deploy an agent | <2 min | <30s |
| Monthly active users | 20 (alpha) | 5,000 |

---

## 2. Problem Statement

### The Opacity Problem

Autonomous trading systems are black boxes. Users deploy capital into algorithms they cannot observe, understand, or trust. Existing solutions provide dashboards with charts and numbers, but these fail to communicate the *reasoning* behind decisions. Users see that a trade happened but not *why* the agent decided to open a long position during a market downturn.

### The Trust Deficit

Without visibility into agent reasoning, users:
- Cannot distinguish a broken agent from one executing a valid contrarian strategy
- Have no way to learn from agent behavior to improve their own trading intuition
- Struggle to know when to intervene vs. when to let the agent operate
- Cannot compare agents meaningfully beyond raw PnL numbers

### The Access Problem

Setting up autonomous trading requires:
- Deep technical knowledge (API keys, SDK integration, server management)
- Capital for infrastructure (always-on servers, monitoring, alerting)
- Time to build and maintain custom solutions

Most traders who would benefit from autonomous agents lack one or more of these prerequisites.

### Our Solution

Tenacitas Trading Floor makes autonomous trading **observable, understandable, and accessible** by:

1. **Visualizing agent behavior** as pixel-art avatars in a virtual office -- agents walk to the "research desk" when analyzing markets, move to the "trading terminal" when executing orders, and gather at the "water cooler" when waiting for signals
2. **Exposing agent reasoning** through real-time thought bubbles, activity logs, and decision audit trails powered by Claude's chain-of-thought capabilities
3. **Removing infrastructure burden** by running agents as Durable Objects on Cloudflare's edge network -- no servers to manage, automatic global distribution, and pay-per-use pricing
4. **Enabling a rental marketplace** where skilled agent creators can monetize their strategies while renters get access without technical overhead

---

## 3. User Personas

### 3.1 The Agent Creator ("The Quant")

**Profile:** Experienced trader or developer who builds and configures trading agents.

- **Goals:** Deploy autonomous agents that execute their strategies 24/7; monetize strategies via rental marketplace; monitor and tune agent parameters
- **Pain points:** Existing infra is expensive and fragile; no good way to visually debug agent behavior; sharing strategies requires trust mechanisms
- **Technical level:** High -- comfortable with APIs, strategy parameters, risk management concepts
- **Key workflows:** Create agent -> Configure strategy -> Set risk limits -> Deploy -> Monitor -> Iterate

### 3.2 The Agent Renter ("The Hands-Off Trader")

**Profile:** Trader who wants autonomous execution without building their own systems.

- **Goals:** Find proven agents, rent them, allocate capital, and profit without active management
- **Pain points:** Cannot evaluate agent quality without transparency; worried about rogue agents; wants easy on/off control
- **Technical level:** Medium -- understands trading concepts but not infrastructure
- **Key workflows:** Browse marketplace -> Evaluate agent track record -> Rent -> Connect wallet -> Monitor PnL -> Withdraw

### 3.3 The Spectator ("The Observer")

**Profile:** Crypto-curious user who watches the trading floor for entertainment or education.

- **Goals:** Learn about trading strategies by observing agents; enjoy the visual experience; potentially convert to renter
- **Pain points:** Trading is intimidating; existing tools are not engaging; wants to learn passively
- **Technical level:** Low to medium
- **Key workflows:** Visit trading floor -> Watch agents -> Read agent thought bubbles -> Follow interesting agents -> Eventually rent

### 3.4 The Platform Operator ("The Admin")

**Profile:** The Tenacitas team managing the platform.

- **Goals:** Ensure platform reliability; manage agent lifecycle; handle disputes; grow user base
- **Pain points:** Need visibility into all agents; must enforce risk limits; require audit trails
- **Technical level:** Very high
- **Key workflows:** Monitor system health -> Review flagged agents -> Manage platform risk limits -> Deploy updates

---

## 4. Phase 1 -- Engine & Execution (Core)

Phase 1 delivers the foundational trading engine: AI agents that can reason about markets and execute trades on Hyperliquid. No visual interface yet -- this phase is API-only and focuses on correctness, safety, and reliability.

### 4.1 Features

#### 4.1.1 Agent Lifecycle Management

**Description:** CRUD operations for trading agents. Each agent is a logical entity with a unique ID, configuration, and state machine governing its lifecycle.

**Agent States:**

```
CREATED -> CONFIGURING -> READY -> RUNNING -> PAUSED -> STOPPED -> ARCHIVED
                                     |          ^
                                     v          |
                                   ERROR -------+
```

**User Stories:**

| ID | Story | Acceptance Criteria |
|---|---|---|
| US-1.1 | As a creator, I want to create a new agent with a name and strategy so I can begin configuring it | Agent is created with a unique UUID; state is `CREATED`; agent record is stored in D1; creation timestamp is recorded |
| US-1.2 | As a creator, I want to configure my agent's strategy parameters (pairs, leverage, risk limits) so it trades according to my preferences | Agent transitions to `CONFIGURING`; parameters are validated against allowed ranges; invalid parameters return descriptive errors; configuration is persisted to D1 |
| US-1.3 | As a creator, I want to start my agent so it begins autonomous trading | Agent transitions from `READY` to `RUNNING`; a Durable Object is spawned for the agent; the agent begins its reasoning loop; a start event is logged |
| US-1.4 | As a creator, I want to pause my agent so it stops opening new positions but maintains existing ones | Agent transitions to `PAUSED`; no new orders are placed; existing positions are maintained; the agent continues monitoring but does not act |
| US-1.5 | As a creator, I want to stop my agent so it closes all positions and shuts down | Agent transitions to `STOPPED`; all open positions are closed (market orders); all open orders are cancelled; final state is logged; Durable Object is cleaned up |
| US-1.6 | As a creator, I want to view my agent's current status and configuration | API returns agent state, configuration, current positions, PnL summary, and last activity timestamp |
| US-1.7 | As a creator, I want to delete/archive my agent when I no longer need it | Agent transitions to `ARCHIVED`; agent data is retained for audit purposes; agent no longer appears in active listings |

**API Endpoints:**

```
POST   /api/v1/agents              -- Create agent
GET    /api/v1/agents              -- List agents (paginated)
GET    /api/v1/agents/:id          -- Get agent details
PATCH  /api/v1/agents/:id          -- Update agent configuration
POST   /api/v1/agents/:id/start    -- Start agent
POST   /api/v1/agents/:id/pause    -- Pause agent
POST   /api/v1/agents/:id/stop     -- Stop agent
DELETE /api/v1/agents/:id          -- Archive agent
GET    /api/v1/agents/:id/logs     -- Get agent activity logs
GET    /api/v1/agents/:id/positions -- Get current positions
```

#### 4.1.2 AI Reasoning Engine (Claude Integration)

**Description:** Each running agent uses Claude (via CF AI Gateway) as its reasoning engine. The agent operates on a loop: observe market state, reason about it, decide on actions, execute.

**Agent Reasoning Loop:**

```
1. OBSERVE  -- Gather market data (prices, orderbook, funding rates, recent trades)
2. ANALYZE  -- Send context to Claude for financial reasoning
3. DECIDE   -- Claude returns structured decision (trade/hold/close + rationale)
4. VALIDATE -- Check decision against risk limits (max position size, max drawdown, etc.)
5. EXECUTE  -- If valid, submit order to Hyperliquid
6. LOG      -- Record full decision context (input, reasoning, output, execution result)
7. WAIT     -- Sleep for configured interval, then repeat
```

**User Stories:**

| ID | Story | Acceptance Criteria |
|---|---|---|
| US-2.1 | As a creator, I want my agent to analyze market conditions using Claude so it makes informed trading decisions | Agent sends structured prompt to Claude with market context; Claude returns a JSON decision object with action, parameters, and rationale; response is parsed and validated |
| US-2.2 | As a creator, I want to see my agent's reasoning for each decision so I can understand and trust its behavior | Each decision cycle logs: input context, Claude prompt, Claude response, parsed decision, risk validation result, and execution outcome -- all stored as JSONL in R2 |
| US-2.3 | As a creator, I want my agent to respect risk limits even if Claude suggests an aggressive trade | Risk validation layer runs AFTER Claude's decision but BEFORE execution; violations are logged but not executed; agent does not override risk limits |
| US-2.4 | As a creator, I want to configure the reasoning interval (how often the agent thinks) | Configurable interval between 10 seconds and 1 hour; default is 60 seconds; interval is respected even if previous cycle is still running (skip, do not queue) |

**Claude Prompt Structure:**

The system prompt establishes the agent's persona and strategy. The user prompt contains real-time market data. Claude responds with a structured JSON decision.

```
System: You are a {strategy_name} trading agent. Your parameters: {strategy_config}.
        You trade {pairs} on Hyperliquid PERPS with max {leverage}x leverage.
        Current portfolio: {positions}. Risk limits: {risk_config}.
        Respond ONLY with a valid JSON decision object.

User:   Market snapshot at {timestamp}:
        - {pair} price: {price}, 24h change: {change}%
        - Funding rate: {funding}
        - Order book depth: {depth}
        - Recent trades: {trades}
        - Technical indicators: {indicators}

Response (expected):
{
  "action": "OPEN_LONG" | "OPEN_SHORT" | "CLOSE" | "HOLD" | "ADJUST",
  "pair": "BTC-USD",
  "size": 0.1,
  "leverage": 5,
  "order_type": "LIMIT" | "MARKET",
  "limit_price": 65000.00,  // only for LIMIT orders
  "stop_loss": 63000.00,
  "take_profit": 70000.00,
  "rationale": "Funding rate is deeply negative (-0.05%), suggesting..."
  "confidence": 0.82
}
```

#### 4.1.3 Hyperliquid Trading Execution

**Description:** Integration with Hyperliquid's API for perpetual futures trading. Handles order submission, position management, and market data retrieval.

**User Stories:**

| ID | Story | Acceptance Criteria |
|---|---|---|
| US-3.1 | As a creator, I want my agent to place market and limit orders on Hyperliquid | Agent can submit MARKET and LIMIT orders; orders are confirmed with Hyperliquid order ID; order status is tracked until filled/cancelled |
| US-3.2 | As a creator, I want my agent to manage stop-loss and take-profit orders | Agent places SL/TP orders alongside position entries; SL/TP are updated if the agent adjusts the position; orphaned SL/TP orders are cleaned up on position close |
| US-3.3 | As a creator, I want to see my agent's current positions and PnL in real time | API returns current open positions with entry price, current price, unrealized PnL, margin used, liquidation price |
| US-3.4 | As a creator, I want my agent to handle order failures gracefully | Failed orders are retried up to 3 times with exponential backoff; persistent failures trigger an alert and the agent transitions to `ERROR` state; partial fills are handled correctly |
| US-3.5 | As a creator, I want my agent's trading pairs to be restricted to configured pairs only | Agent can only trade pairs listed in its configuration; attempts to trade unconfigured pairs are blocked at the validation layer |

**Supported Order Types:**
- Market orders (immediate execution)
- Limit orders (price-specified)
- Stop-loss orders (protective)
- Take-profit orders (profit-securing)

**Supported Pairs (Phase 1):**
- BTC-USD PERP
- ETH-USD PERP
- SOL-USD PERP
- ARB-USD PERP
- Additional pairs can be added via configuration

#### 4.1.4 Secure Key Management

**Description:** Agent private keys (for signing Hyperliquid transactions) must be stored and handled securely. Keys never leave the Cloudflare Workers runtime.

**User Stories:**

| ID | Story | Acceptance Criteria |
|---|---|---|
| US-4.1 | As a creator, I want to securely provide my Hyperliquid API credentials so my agent can trade on my behalf | Credentials are encrypted at rest using CF Workers secrets; keys are never logged or exposed via API responses; keys are only decrypted within the DO runtime |
| US-4.2 | As a creator, I want to revoke my agent's access to my credentials at any time | Revoking credentials immediately stops the agent; credentials are deleted from storage; any in-flight operations complete but no new operations are initiated |
| US-4.3 | As the platform, I want to ensure private keys are never transmitted in plaintext | All key submission endpoints require HTTPS; keys are encrypted before storage; API responses never include raw key material |

**Implementation Notes:**
- API keys are submitted over HTTPS and immediately encrypted using Cloudflare Workers Secrets / encrypted KV
- Each agent's Durable Object decrypts keys only when signing transactions
- Keys are scoped to the specific agent -- no shared key access
- Key rotation is supported without agent downtime

#### 4.1.5 Activity Logging

**Description:** Comprehensive, append-only activity logging for every agent action. Logs serve as an audit trail, debugging tool, and future input for the visual layer.

**User Stories:**

| ID | Story | Acceptance Criteria |
|---|---|---|
| US-5.1 | As a creator, I want to view my agent's complete activity history | API returns paginated log entries; logs include all decision cycles, orders, state transitions, and errors; logs are ordered chronologically |
| US-5.2 | As a creator, I want to filter logs by type (decisions, trades, errors) | API supports filtering by log type; multiple filters can be combined |
| US-5.3 | As the platform, I want logs to be immutable and tamper-evident | Logs are stored as append-only JSONL files in R2; each entry includes a hash chain linking to the previous entry; logs cannot be modified after writing |

**Log Entry Schema:**

```json
{
  "id": "uuid",
  "agent_id": "uuid",
  "timestamp": "2026-02-14T12:00:00.000Z",
  "type": "DECISION" | "ORDER" | "FILL" | "STATE_CHANGE" | "ERROR" | "SYSTEM",
  "data": {
    // Type-specific payload
  },
  "prev_hash": "sha256-of-previous-entry"
}
```

**Storage Strategy:**
- Logs are written as JSONL (one JSON object per line) to R2
- File naming: `logs/{agent_id}/{YYYY-MM-DD}.jsonl`
- Hot logs (last 24h) are also cached in KV for fast retrieval
- Logs are retained indefinitely (R2 storage is cost-effective)

#### 4.1.6 Agent Configuration Schema

**Description:** The structured configuration that defines an agent's behavior, strategy, and constraints.

```json
{
  "agent_id": "uuid",
  "name": "BTC Momentum Alpha",
  "owner_id": "uuid",
  "strategy": {
    "type": "MOMENTUM" | "MEAN_REVERSION" | "FUNDING_RATE" | "BREAKOUT" | "NEWS_SENTIMENT",
    "params": {
      // Strategy-specific parameters
    }
  },
  "trading": {
    "pairs": ["BTC-USD"],
    "max_leverage": 10,
    "max_position_size_usd": 10000,
    "max_concurrent_positions": 3,
    "order_types": ["MARKET", "LIMIT"]
  },
  "risk": {
    "max_drawdown_pct": 10,
    "max_daily_loss_usd": 500,
    "max_single_trade_loss_usd": 200,
    "stop_loss_required": true,
    "force_stop_on_drawdown": true
  },
  "reasoning": {
    "model": "claude-sonnet-4-5-20250514",
    "interval_seconds": 60,
    "temperature": 0.3,
    "max_tokens": 1024
  },
  "notifications": {
    "on_trade": true,
    "on_error": true,
    "on_drawdown_threshold": true
  }
}
```

### 4.2 Phase 1 Acceptance Criteria (Summary)

| Criterion | Requirement |
|---|---|
| Agent can be created, configured, started, paused, stopped, and archived via API | Must pass all lifecycle state transitions |
| Agent executes Claude reasoning loop at configured intervals | Loop runs within +/-5s of configured interval |
| Agent places orders on Hyperliquid testnet | Orders appear on Hyperliquid testnet with correct parameters |
| Risk limits are enforced before every trade | No order is submitted that violates configured risk limits |
| All agent activity is logged to R2 in JSONL format | Logs are retrievable and contain complete decision context |
| API keys are encrypted at rest | Keys are never exposed in logs, API responses, or error messages |
| Agent handles errors gracefully (API failures, rate limits, network issues) | Agent retries with backoff; transitions to ERROR state on persistent failure |
| API is authenticated and authorized | Only agent owners can access their agents |

### 4.3 Phase 1 Out of Scope

- Visual interface (Phase 3)
- Real-time WebSocket updates (Phase 2)
- Marketplace / rental (Phase 4)
- Payment processing (Phase 4)
- Mobile interface
- Social features (following, sharing)

---

## 5. Phase 2 -- Orchestration (Durable Objects)

Phase 2 introduces real-time state synchronization using Cloudflare Durable Objects and the WebSocket Hibernation API. This phase bridges the backend engine (Phase 1) with the visual frontend (Phase 3).

### 5.1 Core Concepts

- **Agent Room:** Each running agent has a dedicated Durable Object instance that maintains its real-time state and accepts WebSocket connections from observers
- **State Synchronization:** Agent state changes (position updates, decisions, errors) are broadcast to all connected clients via WebSocket messages
- **Delta Serialization:** Only state changes are transmitted, not full state snapshots, to minimize bandwidth
- **WebSocket Hibernation:** Durable Objects use the Hibernation API to minimize costs when no clients are connected

### 5.2 High-Level User Stories

| ID | Story |
|---|---|
| US-6.1 | As a user, I want to connect to an agent's room via WebSocket and receive real-time state updates |
| US-6.2 | As a user, I want to see agent state changes within 200ms of them occurring |
| US-6.3 | As a user, I want to reconnect seamlessly if my WebSocket connection drops |
| US-6.4 | As the platform, I want Durable Objects to hibernate when no clients are connected to save costs |
| US-6.5 | As a user, I want to observe multiple agents simultaneously by connecting to multiple rooms |

### 5.3 State Message Schema

```json
{
  "type": "STATE_DELTA",
  "agent_id": "uuid",
  "seq": 12345,
  "timestamp": "2026-02-14T12:00:00.000Z",
  "changes": {
    "activity": "ANALYZING",
    "current_thought": "BTC funding rate is negative, considering long...",
    "positions": [{ "pair": "BTC-USD", "side": "LONG", "size": 0.1, "pnl": 45.20 }],
    "pnl_total": 1250.00
  }
}
```

### 5.4 Room Architecture

- **Floor Room:** Aggregates all agents on a trading floor; broadcasts summary state (agent positions in the virtual office, high-level activity)
- **Agent Room:** Detailed state for a single agent; full reasoning logs, positions, real-time PnL
- **User Room:** Private room for a user; aggregates state of all their agents, portfolio-level metrics

---

## 6. Phase 3 -- Visual Interface (React + Phaser.js)

Phase 3 delivers the visual trading floor: a pixel-art virtual office where agent avatars move, interact, and visually represent their trading activity.

### 6.1 Core Concepts

- **Trading Floor Scene:** A top-down pixel-art office rendered in Phaser.js with functional zones (trading terminals, research desks, break room, news ticker wall)
- **Agent Avatars:** Each agent is a pixel-art character that moves between zones based on its current activity
- **Activity Visualization:** Agent state maps to visual behavior -- an agent "analyzing" walks to the research desk; an agent "trading" moves to a terminal; an agent in "error" sits at its desk with a red exclamation mark
- **HUD Overlays:** React components overlaid on the Phaser canvas for PnL dashboards, agent details, and controls

### 6.2 High-Level User Stories

| ID | Story |
|---|---|
| US-7.1 | As a user, I want to see a visual trading floor with pixel-art agent avatars |
| US-7.2 | As a user, I want to see agents move to different zones based on their current activity |
| US-7.3 | As a user, I want to click on an agent to see its detailed status, current positions, and reasoning |
| US-7.4 | As a user, I want to see thought bubbles above agents showing their current analysis |
| US-7.5 | As a user, I want to see real-time PnL numbers updating above each agent |
| US-7.6 | As a creator, I want to control my agents (start/stop/pause) directly from the visual interface |
| US-7.7 | As a user, I want the visual floor to feel alive with ambient animations even when agents are idle |

### 6.3 Visual Zone Mapping

| Agent Activity | Visual Zone | Avatar Animation |
|---|---|---|
| IDLE / WAITING | Break room / Water cooler | Standing, occasional idle animations |
| ANALYZING | Research desk | Sitting, looking at screens, thinking bubble |
| DECIDING | Conference table | Pacing, hand on chin |
| EXECUTING | Trading terminal | Typing rapidly, screens flashing |
| MONITORING | Watch tower / Overview desk | Standing, looking at big screen |
| ERROR | Own desk | Red exclamation mark, slumped posture |
| PAUSED | Break room | Sitting with coffee cup, "zzz" bubble |

### 6.4 Tech Stack Details

- **Phaser.js** for the game-like rendering (sprites, tilemaps, animations)
- **React** for UI overlays (dashboards, modals, controls) rendered above the Phaser canvas
- **Vite** for build tooling and HMR during development
- **Cloudflare Pages** for static hosting with edge-optimized delivery

---

## 7. Phase 4 -- Marketplace & Rental

Phase 4 introduces the economic layer: a marketplace where agent creators can list their agents for rent, and users can browse, evaluate, and rent agents.

### 7.1 Core Concepts

- **Agent Listings:** Creators publish agents with descriptions, strategy summaries (without revealing proprietary details), and historical performance metrics
- **Rental Models:** Time-based (pay per day/week/month) and success-fee (percentage of profits)
- **On-Chain Payments:** Payments processed on Base network using Clanker/Bankr integration
- **Reputation System:** Agents earn reputation based on performance, uptime, and user ratings
- **Public Audit Logs:** Renters can view anonymized decision logs to verify agent behavior

### 7.2 High-Level User Stories

| ID | Story |
|---|---|
| US-8.1 | As a creator, I want to list my agent on the marketplace with pricing and description |
| US-8.2 | As a renter, I want to browse agents by strategy type, performance, and price |
| US-8.3 | As a renter, I want to see an agent's verified historical performance before renting |
| US-8.4 | As a renter, I want to rent an agent and have it trade with my capital |
| US-8.5 | As a creator, I want to earn fees from my agent rentals automatically |
| US-8.6 | As a renter, I want to stop renting an agent at any time and have my capital returned |
| US-8.7 | As a user, I want to see agent reputation scores based on performance and reliability |

### 7.3 Payment Flows

- **Time-based rental:** Renter pays upfront for a rental period; payment is held in escrow; released to creator at period end
- **Success fee:** Renter pays a percentage (e.g., 20%) of profits; calculated at rental end or at defined intervals; no fee if agent produces no profit
- **Platform fee:** Tenacitas takes a 5-10% platform fee on all rental transactions

---

## 8. Non-Functional Requirements

### 8.1 Performance

| Metric | Requirement | Measurement |
|---|---|---|
| Order execution latency (submission to confirmation) | <50ms p99 | Measured from order submission to Hyperliquid API response |
| Agent reasoning cycle total time | <10s p99 | Measured from market data fetch to decision output |
| Claude API response time | <5s p99 | Measured via CF AI Gateway metrics |
| WebSocket message delivery latency | <200ms p99 | Measured from state change to client receipt |
| API response time (CRUD operations) | <100ms p99 | Measured at CF Workers edge |
| Frontend initial load (LCP) | <2s | Measured on 4G connection |

### 8.2 Scalability

| Metric | Requirement |
|---|---|
| Concurrent running agents | 1,000+ |
| Concurrent WebSocket connections per floor | 10,000+ |
| Concurrent WebSocket connections per agent room | 1,000+ |
| API requests per second | 10,000+ |
| Log storage per agent per day | ~10MB (JSONL) |

### 8.3 Reliability

| Metric | Requirement |
|---|---|
| Platform uptime | 99.9% (excludes planned maintenance) |
| Agent uptime (while in RUNNING state) | 99.9% |
| Zero data loss for activity logs | R2 durability: 99.999999999% |
| Automatic recovery from transient failures | Agents auto-recover from network errors, API timeouts |
| Graceful degradation | If Claude API is down, agents pause and resume when available |

### 8.4 Security

| Requirement | Details |
|---|---|
| Authentication | JWT-based auth for API access; API keys for programmatic access |
| Authorization | Owner-only access to agent management; configurable visibility for agent data |
| Key security | Private keys encrypted at rest; never logged; never in API responses |
| Data isolation | Multi-tenant: agents and data are strictly isolated between users |
| Rate limiting | Per-user and per-agent rate limits on all API endpoints |
| Audit trail | All administrative actions are logged with actor, action, and timestamp |
| HTTPS only | All traffic encrypted in transit |

### 8.5 Observability

| Requirement | Details |
|---|---|
| Structured logging | All services emit structured JSON logs |
| Metrics | Request latency, error rates, agent states, order execution stats |
| Alerting | Alerts on error rate spikes, agent failures, and latency degradation |
| Tracing | Distributed tracing across Workers, DOs, and external API calls |

---

## 9. Architecture Overview

### 9.1 High-Level System Diagram

```
+------------------+       +---------------------+       +------------------+
|                  |       |                     |       |                  |
|   CF Pages       |<----->|   CF Workers        |<----->|  Hyperliquid     |
|   (React+Phaser) |  WS   |   (Hono API)        |  REST |  PERPS API       |
|                  |       |                     |       |                  |
+------------------+       +----------+----------+       +------------------+
                                      |
                           +----------+----------+
                           |                     |
                           |  Durable Objects     |
                           |  (Agent Rooms)       |
                           |                     |
                           +----------+----------+
                                      |
                    +-----------------+-----------------+
                    |                 |                 |
              +-----+-----+   +------+------+   +-----+-----+
              |           |   |            |   |           |
              |    R2     |   |     D1     |   |    KV     |
              |  (Logs)   |   | (Metadata) |   |  (Cache)  |
              |           |   |            |   |           |
              +-----------+   +------------+   +-----------+
                                      |
                              +-------+-------+
                              |               |
                              | CF AI Gateway |
                              |               |
                              +-------+-------+
                                      |
                              +-------+-------+
                              |               |
                              |  Claude API   |
                              |               |
                              +---------------+
```

### 9.2 Monorepo Structure

```
openclaw-village/
  apps/
    agent-api/          -- Hono API on CF Workers (core backend)
    trading-floor/       -- React + Vite + Phaser.js on CF Pages (frontend)
  packages/
    agent-core/          -- Agent lifecycle, reasoning loop, state machine
    hyperliquid-sdk/     -- Hyperliquid API client (typed, tested)
    trading-strategies/  -- Strategy implementations (Momentum, Mean Reversion, etc.)
    shared-types/        -- Shared TypeScript types across all packages
    ui/                  -- Shared React UI components
    biome-config/        -- Linter configuration
    typescript-config/   -- TSConfig base
  docs/
    specs/               -- Product and technical specifications
```

### 9.3 Cloudflare Services Mapping

| Service | Usage |
|---|---|
| **Workers** | API layer (Hono), request routing, authentication, business logic |
| **Durable Objects** | Agent runtime (one DO per agent), WebSocket rooms, state management |
| **R2** | Activity logs (JSONL), agent state snapshots, static assets |
| **D1** | Agent metadata, user accounts, configuration, marketplace listings |
| **KV** | Hot cache (recent logs, market data), session data, rate limit counters |
| **Pages** | Frontend hosting (React + Phaser.js SPA) |
| **AI Gateway** | Proxy for Claude API calls; provides logging, rate limiting, caching, and fallback |
| **Queues** (future) | Async job processing (report generation, notifications) |

### 9.4 Data Flow: Trade Execution

```
1. Agent DO timer fires (reasoning interval)
2. Agent fetches market data from Hyperliquid API
3. Agent constructs prompt with market context + strategy config
4. Agent sends prompt to Claude via CF AI Gateway
5. Claude returns structured decision JSON
6. Agent validates decision against risk limits
7. If valid: Agent submits order to Hyperliquid API
8. Agent receives order confirmation
9. Agent logs full cycle to R2 (JSONL)
10. Agent broadcasts state delta to connected WebSocket clients
11. Agent updates position/PnL cache in KV
12. Agent schedules next reasoning cycle
```

---

## 10. Open Questions & Risks

### 10.1 Open Questions

| # | Question | Impact | Owner |
|---|---|---|---|
| OQ-1 | What Hyperliquid API rate limits apply, and how do we handle 1,000+ agents making concurrent requests? | Could limit scalability; may need request pooling or agent scheduling | Engineering |
| OQ-2 | Should agents share a single Hyperliquid sub-account or each have their own? | Affects key management, position isolation, and gas costs | Product + Engineering |
| OQ-3 | How do we handle Claude API outages -- should agents fall back to simpler rule-based logic? | Affects reliability; agents cannot reason without Claude | Product |
| OQ-4 | What is the minimum viable strategy set for Phase 1 launch? | Affects scope and timeline | Product |
| OQ-5 | How do we price agent rentals in Phase 4 -- flat rate, success fee, or both? | Affects marketplace economics and user acquisition | Product + Business |
| OQ-6 | Should spectators see real agent data or delayed/anonymized data? | Affects privacy and competitive dynamics | Product + Legal |
| OQ-7 | What regulatory considerations apply to operating autonomous trading agents as a service? | Could affect product design, geographic availability, and required disclosures | Legal |
| OQ-8 | How do we handle agent-to-agent interactions on the visual floor? | Affects Phase 3 design; purely cosmetic vs. meaningful interaction | Product + Design |

### 10.2 Risks

| # | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| R-1 | **Hyperliquid API instability** -- exchange API changes or goes down | Medium | High | Abstract Hyperliquid behind an SDK wrapper; implement circuit breaker; consider multi-exchange support long-term |
| R-2 | **Claude API latency spikes** -- slow responses delay trading decisions | Medium | High | Set strict timeouts; cache recent decisions; implement AI Gateway fallback; consider pre-computed signals for time-sensitive situations |
| R-3 | **Agent causes significant user losses** -- bad trade or bug | High | Critical | Enforce strict risk limits; require stop-losses; implement circuit breakers (auto-pause on drawdown); clear disclaimers and terms of service |
| R-4 | **Security breach exposing private keys** -- keys stolen from storage | Low | Critical | Encrypt at rest; minimize key exposure surface; use CF Workers security model (V8 isolates); regular security audits; consider MPC or vault integration |
| R-5 | **Durable Object cost explosion** -- 1,000+ DOs running 24/7 | Medium | Medium | Use WebSocket Hibernation API aggressively; batch operations; monitor costs closely; implement agent sleep schedules |
| R-6 | **Regulatory action** -- platform classified as investment advisor or broker | Medium | Critical | Consult legal counsel early; implement geographic restrictions if needed; position as infrastructure/tools rather than advice |
| R-7 | **User trust failure** -- users do not trust AI agents with their money | High | High | Maximum transparency (reasoning logs, audit trails); start with testnet; gradual capital limits; visual interface builds trust through observability |
| R-8 | **Phaser.js performance** -- visual floor lags with many agents | Medium | Medium | Limit visible agents per floor; use sprite pooling; implement LOD (level of detail); offscreen agents use simplified rendering |

### 10.3 Assumptions

1. Hyperliquid PERPS API remains stable and accessible throughout development
2. Claude API via CF AI Gateway provides adequate latency for near-real-time trading decisions
3. Cloudflare Durable Objects can handle the target scale of 1,000+ concurrent agents
4. Users are willing to entrust API keys to a cloud-based trading platform
5. The pixel-art visual metaphor resonates with the target audience and differentiates the product
6. Base network + Clanker/Bankr provides sufficient payment infrastructure for Phase 4

---

*This is a living document. It will be updated as questions are resolved and requirements evolve.*
