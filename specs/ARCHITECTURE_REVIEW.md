# OpenClaw Village - Architecture Review

**Reviewed:** 2026-02-14
**Reviewer:** Technical Lead / Architecture Review Agent
**Scope:** Full codebase audit of apps/engine-api, apps/agent-dashboard, packages/hyperliquid-sdk, packages/types

---

## Table of Contents

1. [Executive Summary](#executive-summary)
2. [Project Structure](#project-structure)
3. [Code Quality Assessment](#code-quality-assessment)
4. [WebSocket Issues (Critical)](#websocket-issues-critical)
5. [BotInstance / MolWorker Pattern](#botinstance--molworker-pattern)
6. [Hyperliquid SDK Review](#hyperliquid-sdk-review)
7. [Type System Review](#type-system-review)
8. [Frontend Review](#frontend-review)
9. [Security Review](#security-review)
10. [Local Development (wrangler dev)](#local-development-wrangler-dev)
11. [Priority Recommendations](#priority-recommendations)

---

## Executive Summary

OpenClaw Village is an early-stage but well-structured monorepo for AI-powered perpetual futures trading on Hyperliquid. The foundation is solid -- the monorepo tooling (turbo + bun), the Cloudflare Workers + Durable Objects architecture, and the Hyperliquid SDK are all well-chosen and competently built.

**What works well:**
- Monorepo structure with clean package boundaries
- Hyperliquid SDK is comprehensive and production-quality
- Durable Object pattern for bot lifecycle is architecturally sound
- Canvas-based office visualization is creative and functional
- Type definitions in `packages/types` are thorough and well-designed

**What needs immediate work:**
- WebSocket layer (GameRoom) is a non-functional placeholder -- critical gap
- AiService is instantiated but never used in the bot loop
- Strategy is purely random -- no real market analysis
- Zero authentication on all APIs and WebSocket connections
- Significant type drift between `packages/types` definitions and actual backend usage

**Overall Assessment:** Strong foundation, needs 2-3 sprints of focused work to become a viable trading platform.

---

## Project Structure

```
openclaw-village/
  apps/
    engine-api/          # Cloudflare Worker + Durable Objects (Hono)
    agent-dashboard/     # React 19 + Vite + Canvas 2D frontend
  packages/
    hyperliquid-sdk/     # Hyperliquid perps SDK (viem-based)
    types/               # Shared TypeScript type definitions
    ui/                  # (exists in package.json but empty/unused)
```

**Monorepo Quality: GOOD**
- turbo.json properly defines task dependencies and caching
- Workspace packages use `workspace:*` references
- bun@1.2.20 as package manager -- modern and fast
- husky + commitizen + biome for code quality enforcement
- Package boundaries are clean: SDK has no backend deps, types are standalone

**Minor Issues:**
- `packages/ui` is listed in workspaces but appears unused (only `package.json` modified per git status)
- No `@repo/types` dependency in engine-api's `package.json` (types from that package are not imported in the backend)
- turbo.json references `database:generate` and `database:push` tasks -- holdover from a template, no database in this project

---

## Code Quality Assessment

### apps/engine-api

**File: `src/index.ts` (Hono Router)**
- Clean, idiomatic Hono usage
- CORS configured with specific origins (good)
- Route structure follows REST conventions
- Bot management routes correctly proxy to Durable Object stubs

Issues:
- Lines 38-41: Request URL rewriting for DO proxying works but is fragile. The `new URL(c.req.url)` + `url.pathname = ...` pattern could break if query params or headers need forwarding. Consider using `c.req.raw` like the room route does, or at minimum forward the request body for POST routes.
- Line 69: Room route uses a catch-all `/*` which is fine, but the inner DO only handles WebSocket upgrades. Any non-WebSocket request to `/api/room/:id/anything` gets a 426 error.
- No request validation or input sanitization on any route.

**File: `src/durable-objects/BotInstance.ts`**
- Alarm-based execution loop is the correct CF pattern for periodic work
- State persistence via `ctx.storage` is properly implemented
- Dual-write to DO storage + R2 backup is a good resilience pattern

Issues:
- Line 91: `AiService` is instantiated every tick but NEVER USED. This is the most significant functional gap -- the AI reasoning engine exists but isn't wired into the decision loop.
- Line 94: `testnet: this.env.HYPERLIQUID_TESTNET === "true" || true` -- the `|| true` means testnet is ALWAYS true regardless of env var. This is clearly a development shortcut but dangerous if someone expects mainnet behavior.
- Line 17-21: `state` and `env` are stored as instance properties AND inherited from `DurableObject` via `super(state, env)`. The `this.state` assignment shadows `this.ctx.state` from the parent class. While not buggy today, it's confusing.
- Lines 44-46: State is loaded in `fetch()` and `alarm()` separately, but on `fetch()` the `botState` is loaded into `this.botState` which could be stale if an alarm fires between fetch calls. This is mitigated by DO's single-threaded nature but worth noting.
- Line 136: Alarm interval is hardcoded to 5000ms. Should be configurable per bot.
- Error handling in `alarm()` (lines 118-131) only increments an error counter. No circuit breaker, no exponential backoff, no max-error threshold to auto-stop the bot.

**File: `src/durable-objects/GameRoom.ts`**
- This is a minimal WebSocket broadcast room -- essentially a placeholder
- See [WebSocket Issues](#websocket-issues-critical) for detailed analysis

**File: `src/ai/AiService.ts`**
- Clean implementation routing through CF AI Gateway to Anthropic
- Model is hardcoded to `claude-3-5-sonnet-20240620` -- should be configurable
- Missing: structured output parsing, retry logic, token usage tracking
- The system prompt parameter is optional, which is fine for the interface, but the trading use case demands a carefully crafted system prompt

**File: `src/skills/TradingStrategy.ts`**
- Good interface design: `TradingStrategy` with `name` and `analyze()` method
- `StrategyDecision` type is reasonable but too simple for real trading (no stop-loss, take-profit, leverage, confidence)

**File: `src/skills/strategies/SimpleStrategy.ts`**
- This is explicitly a placeholder -- `Math.random() > 0.8` for buy decisions
- Price is hardcoded to 2000 (line 11)
- The commented-out `client.getTicker("ETH")` call shows intent to use real data
- The SDK's `getTicker()` method actually works -- this should be wired up

**File: `src/storage/StorageAdapter.ts`**
- Dual DO-storage + R2 pattern is well-implemented
- `waitUntil` usage for R2 writes is correct (fire-and-forget with completion guarantee)
- `loadState` fallback from DO storage to R2 is a good resilience pattern

Issues:
- All methods use `any` types for state/log data
- `saveLog` uses `Date.now()` as the R2 key suffix -- two logs in the same millisecond would collide
- No log rotation or cleanup -- R2 bucket will grow unbounded

### TypeScript Usage

**Overall: MIXED**

Positives:
- `packages/types` has excellent type definitions
- `packages/hyperliquid-sdk` has comprehensive types for all API interactions
- SDK uses `as const` assertions and proper generic constraints

Negatives:
- `engine-api` uses `any` extensively: `BotState.lastDecision: any`, `StorageAdapter` methods accept `any`, `recentLogs` is `any[]`
- `agent-dashboard` uses `any` for API responses, bot status, log entries
- The excellent types in `packages/types` are NOT IMPORTED by either the backend or frontend
- `GameRoom.sessions: Map<WebSocket, any>` -- session metadata is untyped

---

## WebSocket Issues (Critical)

### Current State

**GameRoom.ts** is a minimal broadcast room with no protocol, no state management, and no connection to the bot execution system.

Current behavior:
1. Client connects via WebSocket to `/api/room/:id/ws`
2. Server accepts connection, assigns a random UUID
3. Any message received is broadcast to ALL OTHER connected clients (raw, unprocessed)
4. On disconnect, the session is removed from the map

**What's missing (everything):**

### 1. No Structured Protocol
The `packages/types/src/realtime.ts` file defines a complete WebSocket protocol with:
- `ServerMessage`: `STATE_DELTA`, `FULL_STATE`, `ERROR`, `PONG`
- `ClientMessage`: `SUBSCRIBE`, `UNSUBSCRIBE`, `PING`
- `AgentRealtimeState`: full agent state including positions, PnL, visual position, activity

**None of this is implemented.** The GameRoom just re-broadcasts raw strings.

### 2. No Connection to BotInstance State
The BotInstance DO runs its trading loop (alarm cycle) and updates its internal state, but:
- BotInstance never sends state changes to GameRoom
- GameRoom has no reference to BotInstance DOs
- There is no pub/sub mechanism between the two DO classes
- The only way to get bot state is via HTTP polling (`/api/bot/:id/status`)

### 3. No Subscribe/Unsubscribe
The frontend currently connects to a single room ("main") and expects `bot_update` messages (see `App.tsx:194`), but there is no mechanism to:
- Subscribe to specific agent updates
- Filter messages by agent ID
- Receive initial full state on connection

### 4. No Heartbeat/Ping-Pong
- No keepalive mechanism
- No detection of stale connections
- Frontend has reconnect logic (3s timeout) but server doesn't proactively clean up dead connections

### Recommendation: TradingRoom Architecture

Rename `GameRoom` to `TradingRoom` and implement the following:

```
TradingRoom DO
  |
  |-- sessions: Map<WebSocket, { id, subscriptions: Set<agentId> }>
  |
  |-- Handles WebSocket connections from agent-dashboard
  |-- Implements the ClientMessage/ServerMessage protocol from packages/types
  |
  |-- fetch(request):
  |     - WebSocket upgrade: accept + send FULL_STATE for subscribed agents
  |     - POST /notify: receive state updates from BotInstance DOs (internal API)
  |
  |-- webSocketMessage(ws, msg):
  |     - SUBSCRIBE: add agentId to session subscriptions, send FULL_STATE
  |     - UNSUBSCRIBE: remove agentId from session subscriptions
  |     - PING: respond with PONG
  |
  |-- broadcastDelta(agentId, changes):
  |     - Send STATE_DELTA to all sessions subscribed to this agentId

BotInstance DO (modified alarm loop):
  |-- After each tick, POST state delta to TradingRoom DO
  |-- TradingRoom broadcasts to subscribed WebSocket clients
```

**Key design decision:** BotInstance pushes state to TradingRoom via internal HTTP (DO-to-DO fetch), rather than TradingRoom polling BotInstance. This is the correct pattern because:
- DO-to-DO communication via fetch is well-supported in CF
- It avoids polling overhead
- BotInstance knows when its state changes (it just changed it)
- TradingRoom doesn't need to know about alarm schedules

### wrangler.toml Changes Required

```toml
# Rename binding
[[durable_objects.bindings]]
name = "TRADING_ROOM"      # was GAME_ROOM
class_name = "TradingRoom"  # was GameRoom

# Add migration
[[migrations]]
tag = "v2"
renamed_classes = [{from = "GameRoom", to = "TradingRoom"}]
```

---

## BotInstance / MolWorker Pattern

### Current Architecture

The BotInstance DO implements a simple alarm-based execution loop:

```
start() -> setAlarm(1s) -> alarm() -> analyze() -> log() -> setAlarm(5s) -> alarm() -> ...
stop() -> deleteAlarm()
```

This is the correct Cloudflare pattern. Durable Object alarms are the only way to run periodic background work in Workers.

### What Works

1. **Lifecycle management:** Start/stop/status API is clean and functional
2. **State persistence:** BotState is saved to DO storage on every tick and on start/stop
3. **Log persistence:** Dual-write to DO storage (fast, recent logs) and R2 (durable, full history)
4. **Alarm reliability:** CF guarantees alarm delivery even after hibernation

### What Needs Work

#### AiService Integration (HIGH PRIORITY)
The `AiService` is instantiated on line 91 of `BotInstance.ts` but never called. The intended flow should be:

```
alarm() ->
  1. Gather market context (via HyperliquidClient)
  2. Build prompt with market data + current positions + strategy rules
  3. Call AiService.generate() to get Claude's trading decision
  4. Parse the structured response
  5. Apply risk checks
  6. Execute or hold
  7. Log everything
```

Currently, step 3-6 are skipped and replaced with `Math.random()`.

#### Strategy Architecture (MEDIUM PRIORITY)
The current `TradingStrategy` interface is too simple:

```typescript
// Current
interface TradingStrategy {
  name: string;
  analyze(client: HyperliquidClient): Promise<StrategyDecision>;
}

// Recommended
interface TradingStrategy {
  name: string;
  type: StrategyType; // from packages/types
  analyze(context: MarketContext): Promise<StrategySignal>;
  validateRisk(signal: StrategySignal, riskConfig: RiskConfig): RiskCheckResult;
}
```

The strategy should receive pre-fetched market data (not the raw client), and risk validation should be a first-class concern.

#### Error Handling (MEDIUM PRIORITY)
Current error handling:
```typescript
catch (err) {
  console.error("Bot Error:", err);
  this.botState.errors++;
}
```

Needed:
- Exponential backoff on consecutive errors
- Circuit breaker: auto-stop after N consecutive errors
- Error classification: transient (retry) vs permanent (stop)
- Alert mechanism (push error to TradingRoom for frontend display)

#### Tick Interval (LOW PRIORITY)
Hardcoded to 5000ms. Should be configurable per bot and per strategy:
- Scalping strategies: 1-2s
- Swing strategies: 30-60s
- Sentiment analysis: 5-10 minutes

### Can BotInstance Run Locally?

**YES.** Wrangler supports Durable Objects in local development mode.

```bash
cd apps/engine-api
wrangler dev --local
```

This uses `miniflare` under the hood, which includes a full Durable Object runtime with:
- In-memory storage (or SQLite-backed persistent storage with `--persist`)
- Alarm support
- WebSocket support
- R2 bucket emulation

**Important notes for local dev:**
- R2 bucket will be emulated locally (writes go to `.wrangler/state/`)
- Environment variables (HL_PRIVATE_KEY, AI Gateway keys) must be set in `.dev.vars` file
- The `--local` flag is already in `package.json`'s dev script
- Multiple DOs can run concurrently (each bot gets its own isolate)
- Alarms work correctly in local mode

**To test locally:**
```bash
# Terminal 1: Start engine-api
cd apps/engine-api
echo "HL_PRIVATE_KEY=<your-testnet-key>" > .dev.vars
echo "HYPERLIQUID_TESTNET=true" >> .dev.vars
wrangler dev --local

# Terminal 2: Start agent-dashboard
cd apps/agent-dashboard
bun dev

# Terminal 3: Test bot lifecycle
curl -X POST http://localhost:8787/api/bot/bot-alpha/start
curl http://localhost:8787/api/bot/bot-alpha/status
curl http://localhost:8787/api/bot/bot-alpha/logs
curl -X POST http://localhost:8787/api/bot/bot-alpha/stop
```

---

## Hyperliquid SDK Review

### Overall Assessment: GOOD

The SDK at `packages/hyperliquid-sdk` is the most mature component in the codebase. It's well-structured, has comprehensive types, and covers the core Hyperliquid API surface.

### Client Implementation (`client.ts`)

**Strengths:**
- Clean separation: client orchestrates, modules implement (market-data, orders, positions)
- Rate limiter is CF Workers-compatible (no Node.js timers, uses token bucket with `setTimeout`)
- Asset index caching avoids repeated `meta` API calls
- Both read-only (no private key) and read-write modes supported
- Testnet/mainnet configuration is clean

**Issues:**
- Line 86: `await new Promise<void>((resolve) => setTimeout(resolve, waitMs))` -- In CF Workers, `setTimeout` works but with caveats. The DO will stay alive during the wait, which is fine for short waits but could be problematic for long queue situations.
- No retry logic for transient errors (network timeouts, 5xx responses)
- No request timeout configuration -- a hung fetch will block the rate limiter token
- `assetIndexCache` is never invalidated. If Hyperliquid adds new assets, the cache is stale until the DO restarts.

### Auth / EIP-712 Signing (`auth.ts`)

**Strengths:**
- Uses `viem` for EIP-712 signing -- correct choice for CF Workers compatibility (no Node.js crypto deps)
- Private key normalization handles both `0x`-prefixed and raw hex
- Signature splitting into r/s/v is correct

**Potential Issues:**
- Lines 100-103: `hashAction()` just does `JSON.stringify({ action, nonce })`. Hyperliquid's actual signing protocol uses a "phantom agent" pattern where the action is encoded differently depending on the action type. The current implementation may work for basic actions but could fail for complex order types.
- The EIP-712 types define `action` as `string` type (line 38), but Hyperliquid's actual protocol may expect a `bytes32` hash of the action. This needs integration testing against the actual testnet.
- `createWalletClient` + `http()` transport is created on every signing call (line 75-79). This should be cached.
- The `defineChain` call creates a chain config using Hyperliquid REST URL as RPC -- this isn't a real JSON-RPC endpoint. It works because `signTypedData` doesn't make RPC calls, but it's semantically incorrect.

**Recommendation:** Integration test the signing against Hyperliquid testnet before going to production. The phantom agent signing pattern is documented in Hyperliquid's SDK reference and differs from standard EIP-712.

### Market Data (`market-data.ts`)

**Complete and correct.** Covers:
- `meta` -- asset metadata
- `allMids` -- mid prices
- `l2Book` -- order book depth
- `recentTrades` -- trade history
- `candleSnapshot` -- OHLCV data
- `fundingHistory` -- historical funding rates
- `predictedFundings` -- current/predicted funding

All endpoints match Hyperliquid's current API documentation.

### Orders (`orders.ts`)

**Well-implemented.** Covers:
- Limit orders with GTC/IOC/ALO time-in-force
- Trigger orders (stop-loss, take-profit)
- Cancel by order ID
- Batch modify (atomic cancel + replace)
- Close position (market or limit)
- Leverage updates

**Issues:**
- `closePosition()` uses a 5% slippage for market close (line 197). This is aggressive and fine for small positions, but for large positions on illiquid pairs it could still fail. Should be configurable.
- No `cancelByCloid` implementation even though the type exists (`CancelByCloidAction`)
- No order status tracking / fill confirmation
- Market orders aren't native on Hyperliquid -- the IOC-with-aggressive-price pattern is correct but should document this clearly

### Positions (`positions.ts`)

**Functional but has inefficiency:**
- `getAccountInfo()` calls `getClearinghouseState()` and then `getPositions()`, but `getPositions()` internally calls `getClearinghouseState()` again. This makes 2 API calls when 1 would suffice. The code comments acknowledge this (line 47).

### Missing Features

1. **WebSocket Market Data:** Types are defined (`WsSubscription`, `WsMessage`, etc.) but no WebSocket client is implemented. For real-time trading, this is essential -- polling for price updates is too slow.

2. **Bulk Operations:** No batch order placement optimization. Each `placeOrders` call with multiple orders works, but there's no queue/batching for high-frequency scenarios.

3. **CCXT Integration Path:** CCXT has a `hyperliquid` exchange class. The custom SDK is the right choice for CF Workers (CCXT has Node.js deps), but a compatibility layer could allow strategy code to be portable.

4. **User Fills / Trade History:** Request types exist (`UserFillsRequest`, `UserFundingRequest`) but no implementation functions.

5. **Vault Support:** `ExchangeRequest` has `vaultAddress` field but no vault-related methods.

### Constants Review

- Endpoint URLs are correct and current for both mainnet and testnet
- Chain IDs: Mainnet `1337`, Testnet `421614` -- these match Hyperliquid's documentation
- Rate limits (1200 tokens, 20/sec refill for info/exchange; 10 tokens, 10/sec for orders) are reasonable and match Hyperliquid's published limits
- Supported pairs list is reasonable but will become stale -- should be dynamic via `meta` endpoint
- EIP-712 domains use zero address as verifying contract -- correct for Hyperliquid

---

## Type System Review

### packages/types

**Quality: EXCELLENT**

The type definitions are thorough, well-organized, and reflect deep understanding of the trading domain:

- `agent.ts`: Complete agent lifecycle (8 states, 6 activities, 5 strategy types), configuration (strategy, trading, risk, reasoning), and summary types
- `trading.ts`: Trade decisions, positions, orders, PnL summaries, market data snapshots, candles, signals
- `realtime.ts`: Full WebSocket protocol with subscribe/unsubscribe, state delta/full state, ping/pong, visual zones
- `logs.ts`: Structured logging with 6 log types, hash chain (`prevHash` field for audit trail)

### Alignment Issues

**Critical Gap: Types are defined but NOT USED by the backend.**

| Type | Defined In | Used By |
|------|-----------|---------|
| `AgentState` | `packages/types/agent.ts` | Not imported anywhere in engine-api |
| `TradeDecision` | `packages/types/trading.ts` | Not imported anywhere in engine-api |
| `ServerMessage` / `ClientMessage` | `packages/types/realtime.ts` | Not imported anywhere |
| `LogEntry` | `packages/types/logs.ts` | Not imported anywhere |
| `AgentConfig` | `packages/types/agent.ts` | Not imported anywhere |
| `RiskConfig` | `packages/types/agent.ts` | Not imported anywhere |

**The backend defines its own local types that partially overlap:**
- `BotInstance.ts` has a local `BotState` interface (7 fields) vs `Agent` type (12 fields)
- `TradingStrategy.ts` has a local `StrategyDecision` (4 fields) vs `TradeDecision` (10 fields)
- `StorageAdapter` uses `any` everywhere instead of `LogEntry`

**The frontend also doesn't import shared types:**
- `useBotStatus.ts` defines a local `BotStatus` interface
- `OfficeView.tsx` defines a local `BotAgent` interface
- `AgentsView.tsx` defines a local `Agent` interface with mock data

### Recommendations

1. Add `@repo/types` as a dependency to `engine-api/package.json`
2. Replace local `BotState` with types from `packages/types/agent.ts`
3. Replace local `StrategyDecision` with `TradeDecision` from `packages/types/trading.ts`
4. Implement the WebSocket protocol using `ServerMessage`/`ClientMessage` from `packages/types/realtime.ts`
5. Use `LogEntry` type for storage adapter
6. Add `@repo/types` to `agent-dashboard/package.json` and replace local interfaces

---

## Frontend Review

### Architecture

The frontend is a single-page React 19 app with:
- Vite 7 + Tailwind 4 build tooling
- Canvas 2D rendering for a pixel-art "office" view
- Polling-based data fetching (4s interval for bot status/logs)
- WebSocket connection (non-functional due to backend issues)
- Lucide icons for UI elements

### React Patterns

**Quality: GOOD**

- Hooks are properly structured (`useTradingSocket`, `useBotStatus`, `useApiStatus`)
- State management is simple (useState + useEffect) -- appropriate for current complexity
- No unnecessary re-renders (useCallback for API calls)
- Component decomposition is reasonable (App, BotCard, OfficeView, Sidebar)

**Issues:**
- `App.tsx` is doing too much -- polling logic, state management, rendering all in one component. Should extract a `useBotPolling()` hook.
- `useEffect` at line 128 in `App.tsx` has an empty dependency array but references `BOT_DEFS` -- safe because it's a module-level constant, but could be clearer.
- `GameView.tsx` and `AgentsView.tsx` use Pixi.js and mock data respectively, but are imported nowhere in the current app. They appear to be earlier iterations that were replaced by `OfficeView.tsx`.
- `TerminalView.tsx` has hardcoded mock logs -- unused in the current app.

### Canvas Rendering (OfficeView.tsx)

**Quality: GOOD -- creative and functional**

The Canvas 2D office view renders pixel-art style bot characters with:
- Background image loading (`/office.png`)
- Character bobbing animation
- Active/inactive glow effects
- Speech bubbles with word-wrapping and fade-out
- Scanline overlay for retro effect
- Proper DPR handling for Retina displays

**Issues:**
- `requestAnimationFrame` runs continuously even when nothing changes. Should use a dirty flag or pause when tab is inactive.
- Canvas resizes every frame (lines 92-95). Should use ResizeObserver and only resize on actual size change.
- `imageSmoothingEnabled = false` is set every frame -- should be set once.
- No cleanup of `prevTimeRef` -- minor memory leak concern.
- Pixi.js is a dependency (`package.json`) but only used in the abandoned `GameView.tsx`. The current `OfficeView` uses native Canvas 2D. Pixi.js should be removed as a dependency (saves ~200KB).

### WebSocket Client (`useTradingSocket.ts`)

**Functional but disconnected from reality:**
- Connects to `ws://localhost:8787/api/room/main/ws`
- Has reconnect logic (3s timeout)
- Provides `sendMessage` function

**Issues:**
- URL construction (line 13): `WS_URL.replace(/^http/, "ws")` -- fragile. Doesn't handle HTTPS properly (`https` -> `wss` would need `s` handling). Should use `URL` constructor.
- No structured message handling -- just sets `lastMessage` as raw string
- No subscribe/unsubscribe mechanism
- No heartbeat/ping-pong
- Frontend expects `{ type: "bot_update", botId, thought, isRunning }` messages (App.tsx:194) but the backend never sends this format
- Should implement the `ClientMessage`/`ServerMessage` protocol from `packages/types/realtime.ts`

### Polling vs WebSocket

Currently the app uses BOTH:
1. HTTP polling every 4s for bot status and logs (works, but slow)
2. WebSocket for real-time updates (connected but receives nothing useful)

**Recommendation:** Implement proper WebSocket protocol, then:
- Use WebSocket for real-time state updates (position changes, PnL, activity)
- Keep HTTP polling as fallback / initial load
- Reduce poll interval to 15-30s (health check only)

### Unused Views

- `GameView.tsx` -- Pixi.js isometric grid, imported nowhere
- `AgentsView.tsx` -- Mock agent cards, imported nowhere
- `TerminalView.tsx` -- Mock terminal logs, imported nowhere
- `StatCard.tsx` -- Generic stat card component, imported nowhere
- `NavButton.tsx` -- Generic nav button component, imported nowhere
- `App.css` -- Default Vite template CSS, mostly overridden by Tailwind

These should either be integrated into the app or removed to reduce confusion.

---

## Security Review

### Authentication: NONE (CRITICAL)

**There is zero authentication on any endpoint or WebSocket connection.**

- `/api/bot/:id/start` -- anyone can start any bot
- `/api/bot/:id/stop` -- anyone can stop any bot
- `/api/bot/:id/status` -- anyone can read bot state
- `/api/bot/:id/logs` -- anyone can read trading logs
- `/api/room/:id/ws` -- anyone can connect and receive/send WebSocket messages

**Minimum viable auth for trading:**
1. API key authentication (header-based) for REST endpoints
2. Token-based WebSocket authentication (pass token in first message or query param)
3. Bot-level access control (only owner can start/stop their bots)

### Private Key Handling

- `HL_PRIVATE_KEY` is passed as an environment variable/secret (correct)
- The private key is used inside the DO and never exposed via API (correct)
- However, logging `decision` objects to R2/DO storage could inadvertently include sensitive data if the decision object grows to include account details

**Recommendations:**
- Ensure private keys are stored as Wrangler secrets, not in wrangler.toml
- Add a sanitization step before logging to R2
- Consider using Hyperliquid's sub-account/agent wallet pattern to limit exposure

### CORS Configuration

```typescript
origin: ["http://localhost:5173", "https://openclaw-village.pages.dev", "https://openclaw-agent-dashboard.pages.dev"]
```

This is properly scoped -- not using `*`. Good.

However:
- WebSocket connections bypass CORS entirely (by spec). The `Upgrade` check on line 13 of `GameRoom.ts` helps but isn't security.
- `credentials: true` is set -- this means cookies are sent cross-origin. There are no cookies being used currently, so this is safe but unnecessary.

### Rate Limiting

- The Hyperliquid SDK has rate limiting (good)
- The public API endpoints have NO rate limiting (bad)
- An attacker could spam `/api/bot/:id/start` to create thousands of alarm cycles

**Recommendation:** Add Cloudflare rate limiting rules or implement token-bucket middleware in Hono.

### Input Validation

- Bot IDs are user-controlled strings passed directly to `idFromName()`. While CF sanitizes this, there's no validation that the ID format is expected.
- No request body validation on POST routes
- WebSocket messages are broadcast raw without sanitization

---

## Local Development (wrangler dev)

### Confirmed: Full Local Development Works

The `apps/engine-api/package.json` already has the correct dev script:
```json
"dev": "wrangler dev --local"
```

`wrangler dev --local` (using miniflare v3) supports:
- Durable Objects with full alarm support
- R2 bucket emulation (local file storage in `.wrangler/state/`)
- WebSocket connections
- Environment variables via `.dev.vars`

### Setup Steps

1. Create `.dev.vars` in `apps/engine-api/`:
```
HL_PRIVATE_KEY=<hyperliquid-testnet-private-key>
HYPERLIQUID_TESTNET=true
CLOUDFLARE_AI_GATEWAY_API_KEY=<optional-for-ai>
CF_AI_GATEWAY_ACCOUNT_ID=<optional-for-ai>
CF_AI_GATEWAY_GATEWAY_ID=<optional-for-ai>
```

2. Run both services:
```bash
# Using turbo (from repo root):
bun dev

# Or individually:
cd apps/engine-api && bun dev      # Port 8787
cd apps/agent-dashboard && bun dev  # Port 5173
```

3. The agent-dashboard frontend defaults to `http://localhost:8787` for the API URL (set via `VITE_API_URL` env var).

### Known Local Dev Limitations

- AI Gateway requires real Cloudflare credentials (won't work with dummy keys)
- R2 bucket is local-only (data doesn't persist between `wrangler dev` restarts unless `--persist` is used)
- DO alarms may have slightly different timing characteristics locally vs production
- WebSocket connections through `wrangler dev` may have different keepalive behavior

---

## Priority Recommendations

### P0 - Critical (Must Fix)

1. **Implement TradingRoom WebSocket protocol**
   - Rename GameRoom to TradingRoom
   - Implement `ServerMessage`/`ClientMessage` protocol from `packages/types/realtime.ts`
   - Wire BotInstance state changes to TradingRoom via DO-to-DO fetch
   - Update frontend `useTradingSocket` to use structured protocol
   - Add `TRADING_ROOM` env binding to `wrangler.toml` with migration

2. **Wire AiService into bot loop**
   - Build market context prompt (price, positions, order book, funding)
   - Call `AiService.generate()` with trading system prompt
   - Parse structured response into `TradeDecision`
   - Apply risk checks before execution

3. **Add authentication**
   - API key middleware in Hono for REST endpoints
   - WebSocket auth (token in first message)
   - Rate limiting on public endpoints

### P1 - High Priority

4. **Align types across packages**
   - Import `@repo/types` in engine-api and agent-dashboard
   - Replace all local interface duplicates with shared types
   - Remove `any` usage in BotInstance, StorageAdapter, and frontend hooks

5. **Implement real trading strategies**
   - Replace `SimpleStrategy` with actual market analysis
   - Use SDK's market data methods (getTicker, getOrderBook, getCandles, getFundingRates)
   - Implement at least one strategy from `StrategyType` enum

6. **Fix testnet flag bug**
   - `BotInstance.ts:94`: Change `this.env.HYPERLIQUID_TESTNET === "true" || true` to `this.env.HYPERLIQUID_TESTNET === "true"`
   - Make testnet/mainnet configurable per bot

### P2 - Medium Priority

7. **Error handling improvements**
   - Circuit breaker in BotInstance alarm loop
   - Exponential backoff on consecutive errors
   - Error classification and alerting
   - Max error threshold to auto-stop bot

8. **SDK improvements**
   - Integration test EIP-712 signing against testnet
   - Cache `walletClient` in auth.ts
   - Implement WebSocket market data client
   - Add `cancelByCloid` implementation
   - Fix `getAccountInfo` double API call

9. **Frontend cleanup**
   - Remove unused views (GameView, AgentsView, TerminalView) or integrate them
   - Remove Pixi.js dependency (unused)
   - Optimize Canvas render loop (dirty flag, ResizeObserver)
   - Fix WebSocket URL construction for HTTPS

### P3 - Low Priority

10. **Storage improvements**
    - Fix log key collision risk (add random suffix or use monotonic IDs)
    - Add log rotation/TTL for R2 bucket
    - Type the `saveLog`/`saveState` methods properly

11. **Configuration**
    - Make tick interval configurable per bot
    - Make AI model configurable
    - Make market close slippage configurable
    - Add bot configuration API (pairs, leverage, risk params)

12. **Observability**
    - Structured logging (already have `observability.enabled = true` in wrangler.toml)
    - Add tracing for the full tick cycle
    - Dashboard for error rates, tick durations, API latencies

---

## Architecture Decisions Needed

1. **Multi-tenant vs single-tenant:** Currently all bots share one Worker. For production, consider: should each user/team get their own Worker deployment? Or add multi-tenancy with auth?

2. **State machine formalization:** The `AgentState` enum in types defines 8 states but the backend only uses `isRunning: boolean`. Decide whether to implement the full state machine or simplify the types.

3. **Execution model:** Should the AI decide on every tick (current model), or should it set rules that execute mechanically? The 5s tick + AI call + trade execution could be slow for scalping strategies.

4. **Risk management location:** Should risk checks live in the strategy, in BotInstance, or as a separate service? For safety, consider a "Risk Guardian" DO that must approve all trades.

5. **Hyperliquid WebSocket vs REST:** Currently all market data is fetched via REST on each tick. For sub-second strategies, the SDK needs a WebSocket client for streaming prices. Decide the latency requirements first.
