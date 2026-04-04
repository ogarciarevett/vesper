import { DurableObject } from "cloudflare:workers";
import { AiService } from "../ai/AiService";
import { HyperliquidClient } from "@repo/hyperliquid-sdk";
import { StorageAdapter } from "../storage/StorageAdapter";
import type { TradingStrategy } from "../skills/TradingStrategy";
import { createStrategy } from "../skills/strategies/index.js";
import { RiskManager } from "../risk/RiskManager";
import {
  CCXTConnector,
  HyperliquidConnector,
  PriceAggregator,
  type MarketConnector,
} from "../connectors/index.js";
import type {
  AgentActivity,
  AgentMessagePayload,
  AgentMessageType,
  AgentRealtimeState,
  AgentState,
  Candle,
  MarketData,
  Position,
  ProposalPayload,
  ProposalState,
  ReasoningConfig,
  RiskConfig,
  Signal,
  StrategyType,
  TradeDecision,
  TradingConfig,
} from "@repo/types";

/** Internal bot state persisted to DO storage */
interface BotState {
  agentId: string;
  doId: string;
  isRunning: boolean;
  agentState: AgentState;
  activity: AgentActivity;
  startedAt: number | null;
  tickCount: number;
  lastTick: number | null;
  lastDecision: TradeDecision | null;
  currentThought: string | null;
  errors: number;
  consecutiveErrors: number;
  tickIntervalMs: number;
  pair: string;
  roomId: string | null;
  strategyType: StrategyType | "FUNDING_RATE_ARB";
  strategyParams: Record<string, unknown>;
  tradingConfig: TradingConfig;
  riskConfig: RiskConfig;
  reasoningConfig: ReasoningConfig;
  positions: Position[];
  pnlTotal: number;
  pnlToday: number;
  tradeCountToday: number;
  lastTradeAt: string | null;
  /** Prior AI reasoning for context persistence (last 10) */
  reasoningHistory: Array<{
    timestamp: string;
    action: string;
    rationale: string;
    confidence: number;
  }>;
  /** Proposal IDs already executed (prevent double-execution) */
  executedProposalIds: string[];
}

/** Room context fetched before each tick */
interface RoomContext {
  messages: AgentMessagePayload[];
  pendingProposals: ProposalState[];
  approvedProposals: ProposalState[];
}

type StrategySelection = StrategyType | "FUNDING_RATE_ARB";

const DEFAULT_TICK_INTERVAL_MS = 5000;
const MAX_CONSECUTIVE_ERRORS = 5;
const DEFAULT_STRATEGY: StrategySelection = "MOMENTUM_SCALPER";
const DEFAULT_TRADING_CONFIG: TradingConfig = {
  pairs: ["ETH"],
  maxLeverage: 5,
  maxPositionSizeUsd: 5000,
  maxConcurrentPositions: 3,
  orderTypes: ["LIMIT", "MARKET"],
};
const DEFAULT_RISK_CONFIG: RiskConfig = {
  maxDrawdownPct: 10,
  maxDailyLossUsd: 500,
  maxSingleTradeLossUsd: 100,
  stopLossRequired: true,
  forceStopOnDrawdown: true,
};
const DEFAULT_REASONING_CONFIG: ReasoningConfig = {
  model: "anthropic/claude-opus-4-6",
  intervalSeconds: DEFAULT_TICK_INTERVAL_MS / 1000,
  temperature: 0.2,
  maxTokens: 1024,
};
const TRADING_SYSTEM_PROMPT = `You are an autonomous trading agent analyzing perpetual futures markets on Hyperliquid.

Your job is to analyze the provided market data and strategy signal, then make a trading decision.

You MUST respond with a valid JSON object matching this exact schema:
{
  "action": "OPEN_LONG" | "OPEN_SHORT" | "CLOSE" | "HOLD" | "ADJUST",
  "pair": "<trading pair>",
  "size": <position size in USD>,
  "leverage": <leverage multiplier>,
  "orderType": "LIMIT" | "MARKET",
  "limitPrice": <optional limit price>,
  "stopLoss": <stop loss price>,
  "takeProfit": <take profit price>,
  "rationale": "<explanation of your reasoning>",
  "confidence": <0-100>
}

Rules:
- Always include a stop-loss. Capital preservation is paramount.
- Be conservative with position sizing. Never risk more than the configured limits.
- Consider current positions before opening new ones.
- If unsure, return action "HOLD" with your reasoning.
- Base decisions on data, not speculation.`;

export class BotInstance extends DurableObject {
  private readonly _env: Env;
  storage: StorageAdapter;
  strategy: TradingStrategy;
  botState: BotState;

  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
    this._env = env;
    this.storage = new StorageAdapter(state, env.OPENCLAW_DATA);
    this.botState = this.defaultBotState();
    this.strategy = createStrategy(
      this.botState.strategyType,
      this.botState.strategyParams,
    ) as unknown as TradingStrategy;
  }

  private defaultBotState(): BotState {
    const doId = this.ctx.id.toString();
    return {
      agentId: doId,
      doId,
      isRunning: false,
      agentState: "CREATED",
      activity: "IDLE",
      startedAt: null,
      tickCount: 0,
      lastTick: null,
      lastDecision: null,
      currentThought: null,
      errors: 0,
      consecutiveErrors: 0,
      tickIntervalMs: DEFAULT_TICK_INTERVAL_MS,
      pair: "ETH",
      roomId: null,
      strategyType: DEFAULT_STRATEGY,
      strategyParams: {},
      tradingConfig: { ...DEFAULT_TRADING_CONFIG },
      riskConfig: { ...DEFAULT_RISK_CONFIG },
      reasoningConfig: { ...DEFAULT_REASONING_CONFIG },
      positions: [],
      pnlTotal: 0,
      pnlToday: 0,
      tradeCountToday: 0,
      lastTradeAt: null,
      reasoningHistory: [],
      executedProposalIds: [],
    };
  }

  private parseAgentIdFromPath(path: string): string | null {
    const match = path.match(/\/api\/bot\/([^/]+)/);
    if (!match?.[1]) return null;
    return decodeURIComponent(match[1]);
  }

  private normalizeStrategyType(value: unknown): StrategySelection {
    if (typeof value !== "string") return this.botState.strategyType;
    switch (value) {
      case "MOMENTUM_SCALPER":
      case "MEAN_REVERSION":
      case "BREAKOUT_HUNTER":
      case "GRID_TRADER":
      case "SENTIMENT_ANALYZER":
      case "FUNDING_RATE_ARB":
        return value;
      default:
        return this.botState.strategyType;
    }
  }

  private toNumber(
    value: unknown,
    fallback: number,
    min?: number,
    max?: number,
  ): number {
    const parsed =
      typeof value === "number"
        ? value
        : typeof value === "string"
          ? Number(value)
          : Number.NaN;
    if (!Number.isFinite(parsed)) return fallback;
    let next = parsed;
    if (typeof min === "number") next = Math.max(next, min);
    if (typeof max === "number") next = Math.min(next, max);
    return next;
  }

  private toBoolean(value: unknown, fallback: boolean): boolean {
    if (typeof value === "boolean") return value;
    if (typeof value === "string") {
      const lowered = value.toLowerCase();
      if (lowered === "true") return true;
      if (lowered === "false") return false;
    }
    return fallback;
  }

  private setStrategy(
    strategyType: StrategySelection,
    params: Record<string, unknown>,
  ): void {
    this.botState.strategyType = strategyType;
    this.botState.strategyParams = params;

    // Inject API keys for strategies that need external services
    if (strategyType === "POLYMARKET_SCRAPER" && this._env.FIRECRAWL_API_KEY) {
      params.firecrawlApiKey = this._env.FIRECRAWL_API_KEY;
    }

    this.strategy = createStrategy(
      strategyType,
      params,
    ) as unknown as TradingStrategy;
  }

  private applyConfig(payload: Record<string, unknown>): void {
    if (typeof payload.pair === "string" && payload.pair.length > 0) {
      this.botState.pair = payload.pair;
      this.botState.tradingConfig.pairs = [payload.pair];
    }
    if (typeof payload.roomId === "string" && payload.roomId.length > 0) {
      this.botState.roomId = payload.roomId;
    }
    if (payload.tickIntervalMs !== undefined) {
      this.botState.tickIntervalMs = this.toNumber(
        payload.tickIntervalMs,
        this.botState.tickIntervalMs,
        1000,
      );
      this.botState.reasoningConfig.intervalSeconds =
        this.botState.tickIntervalMs / 1000;
    }

    if (payload.reasoning && typeof payload.reasoning === "object") {
      const reasoning = payload.reasoning as Record<string, unknown>;
      const current = this.botState.reasoningConfig;
      if (reasoning.intervalSeconds !== undefined) {
        const intervalSeconds = this.toNumber(
          reasoning.intervalSeconds,
          this.botState.tickIntervalMs / 1000,
          1,
        );
        this.botState.tickIntervalMs = intervalSeconds * 1000;
        this.botState.reasoningConfig.intervalSeconds = intervalSeconds;
      }
      if (typeof reasoning.model === "string" && reasoning.model.trim().length > 0) {
        this.botState.reasoningConfig.model = reasoning.model.trim();
      }
      if (reasoning.temperature !== undefined) {
        this.botState.reasoningConfig.temperature = this.toNumber(
          reasoning.temperature,
          current.temperature,
          0,
          2,
        );
      }
      if (reasoning.maxTokens !== undefined) {
        this.botState.reasoningConfig.maxTokens = Math.floor(
          this.toNumber(reasoning.maxTokens, current.maxTokens, 1),
        );
      }
      if (typeof reasoning.byokAlias === "string") {
        const alias = reasoning.byokAlias.trim();
        this.botState.reasoningConfig.byokAlias = alias.length > 0 ? alias : undefined;
      }
    }

    if (payload.trading && typeof payload.trading === "object") {
      const trading = payload.trading as Record<string, unknown>;
      const current = this.botState.tradingConfig;
      this.botState.tradingConfig = {
        pairs:
          Array.isArray(trading.pairs) && trading.pairs.length > 0
            ? trading.pairs
                .filter((v): v is string => typeof v === "string")
                .map((v) => v.toUpperCase())
            : current.pairs,
        maxLeverage: this.toNumber(
          trading.maxLeverage,
          current.maxLeverage,
          1,
          50,
        ),
        maxPositionSizeUsd: this.toNumber(
          trading.maxPositionSizeUsd,
          current.maxPositionSizeUsd,
          1,
        ),
        maxConcurrentPositions: Math.floor(
          this.toNumber(
            trading.maxConcurrentPositions,
            current.maxConcurrentPositions,
            1,
          ),
        ),
        orderTypes: current.orderTypes,
      };
      if (this.botState.tradingConfig.pairs[0]) {
        this.botState.pair = this.botState.tradingConfig.pairs[0];
      }
    }

    if (payload.risk && typeof payload.risk === "object") {
      const risk = payload.risk as Record<string, unknown>;
      const current = this.botState.riskConfig;
      this.botState.riskConfig = {
        maxDrawdownPct: this.toNumber(
          risk.maxDrawdownPct,
          current.maxDrawdownPct,
          0.1,
          99,
        ),
        maxDailyLossUsd: this.toNumber(
          risk.maxDailyLossUsd,
          current.maxDailyLossUsd,
          1,
        ),
        maxSingleTradeLossUsd: this.toNumber(
          risk.maxSingleTradeLossUsd,
          current.maxSingleTradeLossUsd,
          1,
        ),
        stopLossRequired: this.toBoolean(
          risk.stopLossRequired,
          current.stopLossRequired,
        ),
        forceStopOnDrawdown: this.toBoolean(
          risk.forceStopOnDrawdown,
          current.forceStopOnDrawdown,
        ),
      };
    }

    if (payload.strategy !== undefined) {
      if (typeof payload.strategy === "string") {
        this.setStrategy(
          this.normalizeStrategyType(payload.strategy),
          this.botState.strategyParams,
        );
      } else if (
        payload.strategy &&
        typeof payload.strategy === "object" &&
        !Array.isArray(payload.strategy)
      ) {
        const strategy = payload.strategy as Record<string, unknown>;
        const strategyType = this.normalizeStrategyType(strategy.type);
        const params =
          strategy.params && typeof strategy.params === "object"
            ? (strategy.params as Record<string, unknown>)
            : strategy;
        this.setStrategy(strategyType, params);
      }
    }
  }

  private async loadState(): Promise<void> {
    const saved = await this.ctx.storage.get<Partial<BotState>>("botState");
    if (saved) {
      this.botState = { ...this.defaultBotState(), ...saved };
      if (!saved.reasoningConfig) {
        this.botState.reasoningConfig.intervalSeconds = Math.max(
          1,
          this.botState.tickIntervalMs / 1000,
        );
      }
    }
    this.botState.doId = this.ctx.id.toString();
    this.botState.reasoningConfig.intervalSeconds = Math.max(
      1,
      this.toNumber(
        this.botState.reasoningConfig.intervalSeconds,
        this.botState.tickIntervalMs / 1000,
        1,
      ),
    );
    this.botState.tickIntervalMs = Math.floor(
      this.botState.reasoningConfig.intervalSeconds * 1000,
    );
    this.setStrategy(this.botState.strategyType, this.botState.strategyParams);
  }

  private async saveState(): Promise<void> {
    this.botState.doId = this.ctx.id.toString();
    await this.ctx.storage.put("botState", this.botState);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    await this.loadState();

    const routeAgentId = this.parseAgentIdFromPath(path);
    if (routeAgentId && this.botState.agentId !== routeAgentId) {
      this.botState.agentId = routeAgentId;
    }

    if (request.method === "POST" && path.endsWith("/start")) {
      return this.handleStart(request);
    }
    if (request.method === "POST" && path.endsWith("/stop")) {
      return this.handleStop();
    }
    if (request.method === "GET" && path.endsWith("/status")) {
      return this.handleStatus();
    }
    if (request.method === "GET" && path.endsWith("/logs")) {
      return this.handleLogs();
    }
    if (request.method === "GET" && path.endsWith("/positions")) {
      return Response.json({ positions: this.botState.positions });
    }
    if (request.method === "GET" && path.endsWith("/pnl")) {
      return Response.json({
        pnlTotal: this.botState.pnlTotal,
        pnlToday: this.botState.pnlToday,
        tradeCountToday: this.botState.tradeCountToday,
      });
    }
    if (request.method === "PUT" && path.endsWith("/config")) {
      return this.handleUpdateConfig(request);
    }
    if (request.method === "POST" && path.endsWith("/pause")) {
      return this.handlePause();
    }

    return Response.json({
      status: "Bot Instance Active",
      id: this.ctx.id.toString(),
    });
  }

  private async handleStart(request: Request): Promise<Response> {
    let body: Record<string, unknown> = {};
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      // No body is fine.
    }

    if (body.config && typeof body.config === "object") {
      this.applyConfig(body.config as Record<string, unknown>);
    }
    this.applyConfig(body);

    if (!this.botState.roomId) {
      this.botState.roomId = "main";
    }

    const currentAlarm = await this.ctx.storage.getAlarm();
    if (!currentAlarm) {
      await this.ctx.storage.setAlarm(Date.now() + 1000);
    }

    this.botState.isRunning = true;
    this.botState.agentState = "RUNNING";
    this.botState.activity = "IDLE";
    this.botState.startedAt = this.botState.startedAt || Date.now();
    this.botState.consecutiveErrors = 0;

    await this.saveState();
    await this.reportStateToRoom();

    return Response.json({
      ok: true,
      message: "Bot started",
      state: this.botState,
    });
  }

  private async handleStop(): Promise<Response> {
    await this.ctx.storage.deleteAlarm();
    this.botState.isRunning = false;
    this.botState.agentState = "STOPPED";
    this.botState.activity = "IDLE";

    await this.saveState();
    await this.reportStateToRoom();

    return Response.json({
      ok: true,
      message: "Bot stopped",
      state: this.botState,
    });
  }

  private async handlePause(): Promise<Response> {
    await this.ctx.storage.deleteAlarm();
    this.botState.isRunning = false;
    this.botState.agentState = "PAUSED";
    this.botState.activity = "IDLE";

    await this.saveState();
    await this.reportStateToRoom();

    return Response.json({
      ok: true,
      message: "Bot paused",
      state: this.botState,
    });
  }

  private async handleStatus(): Promise<Response> {
    const currentAlarm = await this.ctx.storage.getAlarm();
    return Response.json({
      ...this.botState,
      id: this.ctx.id.toString(),
      agentId: this.botState.agentId,
      doId: this.ctx.id.toString(),
      isRunning: !!currentAlarm,
      strategy: this.strategy.name,
      strategyType: this.botState.strategyType,
      strategyState: this.strategy.getState(),
      uptime: this.botState.startedAt ? Date.now() - this.botState.startedAt : 0,
    });
  }

  private async handleLogs(): Promise<Response> {
    const logs = (await this.ctx.storage.get<unknown[]>("recentLogs")) ?? [];
    return Response.json({ logs });
  }

  private async handleUpdateConfig(request: Request): Promise<Response> {
    const body = (await request.json()) as Record<string, unknown>;
    if (body.config && typeof body.config === "object") {
      this.applyConfig(body.config as Record<string, unknown>);
    }
    this.applyConfig(body);

    await this.saveState();
    await this.reportStateToRoom();

    return Response.json({
      ok: true,
      message: "Configuration updated",
      state: this.botState,
    });
  }

  async alarm(): Promise<void> {
    console.log("Bot Tick...");
    await this.loadState();

    if (this.botState.consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
      console.error(
        `Bot ${this.botState.agentId} hit circuit breaker after ${MAX_CONSECUTIVE_ERRORS} consecutive errors. Stopping.`,
      );
      this.botState.isRunning = false;
      this.botState.agentState = "ERROR";
      this.botState.activity = "IDLE";
      this.botState.currentThought =
        "Stopped due to too many consecutive errors";
      await this.saveState();
      await this.reportStateToRoom();
      return;
    }

    try {
      const ai = new AiService(this._env);
      const hl = new HyperliquidClient({
        privateKey: this._env.HL_PRIVATE_KEY,
        testnet: this._env.HYPERLIQUID_TESTNET === "true",
      });
      const primaryConnector = new HyperliquidConnector(hl);
      const fallbackConnector = this.buildCcxtFallback();
      const aggregator = new PriceAggregator();
      aggregator.addConnector(primaryConnector);
      if (fallbackConnector) {
        aggregator.addConnector(fallbackConnector);
      }

      // Fetch room conversation context for debate loop
      const roomContext = await this.fetchRoomContext();

      this.botState.activity = "ANALYZING";
      this.botState.currentThought = `Fetching market data for ${this.botState.pair}...`;
      await this.saveState();

      const marketData = await this.fetchMarketData(
        primaryConnector,
        fallbackConnector,
        this.botState.pair,
      );
      const candles = await this.fetchCandles(
        primaryConnector,
        fallbackConnector,
        this.botState.pair,
      );

      this.botState.currentThought = `Running ${this.strategy.name} analysis...`;
      const signal = await this.strategy.analyze(
        marketData,
        candles,
        this.botState.positions,
      );

      console.log(
        `[Bot:${this.botState.agentId}] Signal: ${signal.action} (confidence: ${signal.confidence})`,
      );

      // Inter-agent debate: emit proposals, auto-review, queue executions
      await this.handleDebateReactions(signal, roomContext);

      if (signal.action === "HOLD") {
        this.botState.activity = "COOLDOWN";
        this.botState.currentThought = `Holding: ${signal.metadata.reason ?? "No signal"}`;
        this.botState.tickCount++;
        this.botState.lastTick = Date.now();
        this.botState.consecutiveErrors = 0;

        await this.saveState();
        await this.appendLog({
          timestamp: Date.now(),
          type: "DECISION",
          action: "HOLD",
          signal,
          strategy: this.strategy.name,
        });
        await this.reportDeltaToRoom();
        await this.scheduleNextTick();
        return;
      }

      this.botState.activity = "DECIDING";
      this.botState.currentThought = "AI analyzing trade opportunity...";

      let decision: TradeDecision | null = null;
      try {
        decision = await this.getAiDecision(
          ai,
          signal,
          marketData,
          this.botState.positions,
          roomContext.messages,
        );
        this.botState.currentThought = decision.rationale;

        // Store reasoning for context persistence
        this.botState.reasoningHistory.push({
          timestamp: new Date().toISOString(),
          action: decision.action,
          rationale: decision.rationale,
          confidence: decision.confidence,
        });
        if (this.botState.reasoningHistory.length > 10) {
          this.botState.reasoningHistory = this.botState.reasoningHistory.slice(-10);
        }

        await this.emitAgentMessage(
          `[${this.botState.pair}] ${decision.rationale}`,
          "ANALYSIS",
        );
      } catch (aiErr) {
        console.error("AI reasoning failed, falling back to HOLD:", aiErr);
        this.botState.currentThought =
          "AI reasoning unavailable, holding position";
        await this.emitAgentMessage(
          "AI reasoning unavailable, holding position",
          "STATUS_UPDATE",
        );
        decision = null;
      }

      let equity = 0;
      try {
        const balance = await primaryConnector.getBalance();
        equity = balance.equity;
      } catch {
        if (fallbackConnector) {
          const fallbackBalance = await fallbackConnector.getBalance();
          equity = fallbackBalance.equity;
        }
      }

      const riskManager = new RiskManager(
        this.botState.riskConfig,
        this.botState.tradingConfig,
      );

      if (decision && decision.action !== "HOLD") {
        const riskResult = riskManager.checkTrade(
          decision,
          this.botState.positions,
          this.botState.pnlToday,
          equity,
        );
        if (!riskResult.passed) {
          this.botState.currentThought = `Risk rejected: ${riskResult.reason ?? "unknown reason"}`;
          await this.reportTradeEventToRoom("RISK_REJECTED", {
            decision,
            riskResult,
          });
          await this.appendLog({
            timestamp: Date.now(),
            type: "RISK_REJECTED",
            decision,
            riskResult,
          });
          decision = null;
        }
      }

      if (riskManager.shouldForceStop(this.botState.pnlToday, equity)) {
        this.botState.isRunning = false;
        this.botState.agentState = "ERROR";
        this.botState.activity = "IDLE";
        this.botState.currentThought = "Force-stopped by drawdown circuit breaker";
        await this.ctx.storage.deleteAlarm();
        await this.saveState();
        await this.reportTradeEventToRoom("FORCE_STOP", {
          reason: "drawdown limit breached",
          pnlToday: this.botState.pnlToday,
          equity,
        });
        await this.reportStateToRoom();
        return;
      }

      if (decision && decision.action !== "HOLD") {
        this.botState.activity = "EXECUTING";
        this.botState.currentThought = `Executing ${decision.action} ${decision.pair}...`;
        await this.emitAgentMessage(
          `Executing ${decision.action} on ${decision.pair} (confidence: ${decision.confidence}%)`,
          "STATUS_UPDATE",
        );

        try {
          const execution = await this.executeDecision(
            decision,
            primaryConnector,
            fallbackConnector,
            aggregator,
          );
          this.botState.currentThought =
            execution.message ??
            `Order ${execution.orderId} via ${execution.venue}`;
          this.botState.tradeCountToday++;
          this.botState.lastTradeAt = new Date().toISOString();
          await this.reportTradeEventToRoom("ORDER_PLACED", execution);
          await this.appendLog({
            timestamp: Date.now(),
            type: "ORDER_PLACED",
            decision,
            execution,
          });
        } catch (executionErr) {
          const error = String(executionErr);
          this.botState.currentThought = `Execution failed: ${error}`;
          await this.reportTradeEventToRoom("ORDER_FAILED", {
            decision,
            error,
          });
          await this.appendLog({
            timestamp: Date.now(),
            type: "ORDER_FAILED",
            decision,
            error,
          });
        }
      }

      await this.refreshAccountState(primaryConnector, fallbackConnector);

      this.botState.activity = "MONITORING";
      this.botState.lastDecision = decision;
      this.botState.tickCount++;
      this.botState.lastTick = Date.now();
      this.botState.consecutiveErrors = 0;

      await this.saveState();
      await this.appendLog({
        timestamp: Date.now(),
        type: "DECISION",
        signal,
        decision,
        strategy: this.strategy.name,
        marketPrice: marketData.price,
      });
      await this.reportDeltaToRoom();
    } catch (err) {
      console.error("Bot Error:", err);
      this.botState.errors++;
      this.botState.consecutiveErrors++;
      this.botState.currentThought = `Error: ${String(err)}`;

      await this.appendLog({
        timestamp: Date.now(),
        type: "ERROR",
        error: String(err),
        consecutiveErrors: this.botState.consecutiveErrors,
      });
    }

    await this.saveState();
    await this.scheduleNextTick();
  }

  private buildCcxtFallback(): CCXTConnector | null {
    if (this._env.ENABLE_CCXT_FALLBACK !== "true") return null;
    if (!this._env.CCXT_BINANCE_API_KEY || !this._env.CCXT_BINANCE_API_SECRET) {
      return null;
    }
    return new CCXTConnector({
      apiKey: this._env.CCXT_BINANCE_API_KEY,
      apiSecret: this._env.CCXT_BINANCE_API_SECRET,
      testnet: this._env.CCXT_BINANCE_TESTNET === "true",
    });
  }

  private pickConnector(
    exchange: string | null,
    primary: MarketConnector,
    fallback: MarketConnector | null,
  ): MarketConnector {
    if (!fallback || !exchange) return primary;
    const lower = exchange.toLowerCase();
    if (lower.includes("binance")) return fallback;
    if (lower.includes("hyperliquid")) return primary;
    return primary;
  }

  private async fetchMarketData(
    primary: MarketConnector,
    fallback: MarketConnector | null,
    pair: string,
  ): Promise<MarketData> {
    const attempt = async (connector: MarketConnector): Promise<MarketData> => {
      const [ticker, book] = await Promise.all([
        connector.getTicker(pair),
        connector.getOrderBook(pair, 20),
      ]);
      return {
        pair,
        timestamp: ticker.timestamp,
        price: ticker.midPrice,
        bid: ticker.bid,
        ask: ticker.ask,
        volume24h: ticker.volume24h,
        change24hPct: 0,
        fundingRate: 0,
        openInterest: 0,
        orderBook: {
          bids: book.bids,
          asks: book.asks,
          timestamp: book.timestamp,
        },
      };
    };

    try {
      return await attempt(primary);
    } catch (primaryErr) {
      if (fallback) {
        try {
          return await attempt(fallback);
        } catch (fallbackErr) {
          console.error(
            "Failed to fetch market data from primary and fallback:",
            primaryErr,
            fallbackErr,
          );
        }
      } else {
        console.error("Failed to fetch market data:", primaryErr);
      }
    }

    return {
      pair,
      timestamp: new Date().toISOString(),
      price: 0,
      bid: 0,
      ask: 0,
      volume24h: 0,
      change24hPct: 0,
      fundingRate: 0,
      openInterest: 0,
      orderBook: { bids: [], asks: [], timestamp: new Date().toISOString() },
    };
  }

  private async fetchCandles(
    primary: MarketConnector,
    fallback: MarketConnector | null,
    pair: string,
  ): Promise<Candle[]> {
    try {
      return await primary.getCandles(pair, "5m", 100);
    } catch {
      if (fallback) {
        try {
          return await fallback.getCandles(pair, "5m", 100);
        } catch {
          return [];
        }
      }
      return [];
    }
  }

  private async getAiDecision(
    ai: AiService,
    signal: Signal,
    marketData: MarketData,
    positions: Position[],
    roomMessages?: AgentMessagePayload[],
  ): Promise<TradeDecision> {
    // Build prior decisions context
    const historySection = this.botState.reasoningHistory.length > 0
      ? `\n## Prior Decisions (last ${this.botState.reasoningHistory.length})\n${this.botState.reasoningHistory.map((h) => `[${h.timestamp}] ${h.action} (${h.confidence}%): ${h.rationale}`).join("\n")}\n`
      : "";

    // Build agent conversation context
    const conversationSection = roomMessages && roomMessages.length > 0
      ? `\n## Recent Agent Conversation\n${roomMessages.slice(-10).map((m) => `[${m.fromAgentId}] (${m.messageType}): ${m.content}`).join("\n")}\n`
      : "";

    const prompt = `## Market Data
- Pair: ${marketData.pair}
- Current Price: $${marketData.price}
- Bid: $${marketData.bid} | Ask: $${marketData.ask}
- 24h Volume: $${marketData.volume24h}
- Funding Rate: ${marketData.fundingRate}%

## Order Book (top 5)
Bids: ${marketData.orderBook.bids.slice(0, 5).map(([p, s]) => `$${p} x ${s}`).join(", ") || "N/A"}
Asks: ${marketData.orderBook.asks.slice(0, 5).map(([p, s]) => `$${p} x ${s}`).join(", ") || "N/A"}

## Strategy Signal
- Strategy: ${signal.skillName}
- Action: ${signal.action}
- Confidence: ${signal.confidence}%
- Metadata: ${JSON.stringify(signal.metadata)}

## Current Positions
${positions.length > 0 ? positions.map((p) => `- ${p.pair}: ${p.side} ${p.size} @ $${p.entryPrice} (PnL: $${p.unrealizedPnl})`).join("\n") : "None"}
${historySection}${conversationSection}
Based on this data and context, provide your trading decision as a JSON object.`;

    const response = await ai.generate(prompt, TRADING_SYSTEM_PROMPT, {
      model: this.botState.reasoningConfig.model,
      maxTokens: this.botState.reasoningConfig.maxTokens,
      temperature: this.botState.reasoningConfig.temperature,
      byokAlias: this.botState.reasoningConfig.byokAlias,
    });

    try {
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error("No JSON object found in AI response");
      }
      const parsed = JSON.parse(jsonMatch[0]) as TradeDecision;
      if (!parsed.action || !parsed.pair) {
        throw new Error("AI response missing required fields");
      }

      return {
        action: parsed.action,
        pair: parsed.pair || marketData.pair,
        size: parsed.size || 0,
        leverage: parsed.leverage || 1,
        orderType: parsed.orderType || "LIMIT",
        limitPrice: parsed.limitPrice,
        stopLoss: parsed.stopLoss || 0,
        takeProfit: parsed.takeProfit || 0,
        rationale: parsed.rationale || "No rationale provided",
        confidence: parsed.confidence || signal.confidence,
      };
    } catch (parseErr) {
      console.error("Failed to parse AI response:", parseErr, response);
      return {
        action: "HOLD",
        pair: marketData.pair,
        size: 0,
        leverage: 1,
        orderType: "LIMIT",
        stopLoss: 0,
        takeProfit: 0,
        rationale: `AI response unparseable: ${String(parseErr)}`,
        confidence: 0,
      };
    }
  }

  private async executeDecision(
    decision: TradeDecision,
    primary: MarketConnector,
    fallback: MarketConnector | null,
    aggregator: PriceAggregator,
  ): Promise<{ venue: string; orderId: string; status: string; message?: string }> {
    const pair = decision.pair || this.botState.pair;
    let side: "BUY" | "SELL" = "BUY";
    if (decision.action === "OPEN_SHORT") side = "SELL";
    if (decision.action === "CLOSE") {
      const open = this.botState.positions.find((p) => p.pair === pair);
      if (!open) throw new Error(`Cannot close ${pair}: no open position`);
      side = open.side === "LONG" ? "SELL" : "BUY";
    }
    if (decision.action === "ADJUST") {
      const open = this.botState.positions.find((p) => p.pair === pair);
      side = open?.side === "SHORT" ? "SELL" : "BUY";
    }

    let size = decision.size;
    if (decision.action === "CLOSE") {
      const open = this.botState.positions.find((p) => p.pair === pair);
      size = open?.size ?? size;
    }
    if (!Number.isFinite(size) || size <= 0) {
      throw new Error("Order size must be greater than zero");
    }

    let price = decision.limitPrice;
    let preferredExchange: string | null = null;
    if (!price) {
      try {
        const best = await aggregator.getBestPrice(pair, side);
        const snapshot = side === "BUY" ? best.bestAsk : best.bestBid;
        preferredExchange = snapshot.exchange;
        price = side === "BUY" ? snapshot.ask : snapshot.bid;
      } catch {
        const ticker = await primary.getTicker(pair);
        price = side === "BUY" ? ticker.ask : ticker.bid;
      }
    }

    const preferredConnector = this.pickConnector(
      preferredExchange,
      primary,
      fallback,
    );
    const candidateConnectors = [preferredConnector];
    if (preferredConnector !== primary) {
      candidateConnectors.push(primary);
    }
    if (fallback && preferredConnector !== fallback) {
      candidateConnectors.push(fallback);
    }

    let lastError: unknown = null;
    for (const connector of candidateConnectors) {
      try {
        const result = await connector.placeOrder({
          pair,
          side,
          type: "LIMIT",
          size,
          price,
          reduceOnly: decision.action === "CLOSE",
          stopLoss: decision.stopLoss,
          takeProfit: decision.takeProfit,
        });
        return {
          venue: connector.exchange,
          orderId: result.orderId,
          status: result.status,
          message: result.message,
        };
      } catch (err) {
        lastError = err;
      }
    }

    throw new Error(
      `Execution failed across connectors: ${String(lastError)}`,
    );
  }

  private async refreshAccountState(
    primary: MarketConnector,
    fallback: MarketConnector | null,
  ): Promise<void> {
    try {
      this.botState.positions = await primary.getPositions();
      const balance = await primary.getBalance();
      this.botState.pnlTotal = balance.unrealizedPnl;
      this.botState.pnlToday = balance.unrealizedPnl;
      return;
    } catch {
      if (!fallback) return;
    }

    try {
      this.botState.positions = await fallback!.getPositions();
      const balance = await fallback!.getBalance();
      this.botState.pnlTotal = balance.unrealizedPnl;
      this.botState.pnlToday = balance.unrealizedPnl;
    } catch {
      // Ignore refresh failures, keep previous state.
    }
  }

  private async appendLog(entry: Record<string, unknown>): Promise<void> {
    const logs =
      (await this.ctx.storage.get<Record<string, unknown>[]>("recentLogs")) ??
      [];
    logs.unshift(entry);
    if (logs.length > 50) logs.length = 50;
    await this.ctx.storage.put("recentLogs", logs);
    await this.storage.saveLog(this.botState.agentId || this.ctx.id.toString(), entry);
  }

  private buildRealtimeState(): AgentRealtimeState {
    const activityToZone: Record<AgentActivity, string> = {
      IDLE: "BREAK_ROOM",
      ANALYZING: "RESEARCH_DESK",
      DECIDING: "CONFERENCE_TABLE",
      EXECUTING: "TRADING_TERMINAL",
      MONITORING: "WATCH_TOWER",
      COOLDOWN: "COFFEE_MACHINE",
    };

    return {
      agentId: this.botState.agentId,
      doId: this.ctx.id.toString(),
      state: this.botState.agentState,
      activity: this.botState.activity,
      currentThought: this.botState.currentThought,
      positions: this.botState.positions,
      pnlTotal: this.botState.pnlTotal,
      pnlToday: this.botState.pnlToday,
      tradeCountToday: this.botState.tradeCountToday,
      lastTradeAt: this.botState.lastTradeAt,
      lastMessage: null,
      visualPosition: {
        x: 0,
        y: 0,
        zone: (activityToZone[this.botState.activity] ??
          "BREAK_ROOM") as AgentRealtimeState["visualPosition"]["zone"],
        animation: this.botState.activity === "IDLE" ? "idle" : "working",
      },
    };
  }

  /** Send a conversation message to the room for visualization. Returns the message ID. */
  private async emitAgentMessage(
    content: string,
    messageType: AgentMessageType,
    toAgentId?: string,
    replyToMessageId?: string,
    proposal?: ProposalPayload,
  ): Promise<string | null> {
    if (!this.botState.roomId) return null;
    try {
      const roomDoId = this._env.TRADING_ROOM.idFromName(this.botState.roomId);
      const roomStub = this._env.TRADING_ROOM.get(roomDoId);
      const resp = await roomStub.fetch(
        new Request("https://internal/message", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            fromAgentId: this.botState.agentId,
            toAgentId: toAgentId ?? null,
            content,
            messageType,
            replyToMessageId: replyToMessageId ?? null,
            proposal: proposal ?? undefined,
          }),
        }),
      );
      const result = (await resp.json().catch(() => ({}))) as { messageId?: string };
      return result.messageId ?? null;
    } catch {
      // Non-critical; don't crash the trading loop
      return null;
    }
  }

  /** Fetch recent room context: messages + pending/approved proposals */
  private async fetchRoomContext(): Promise<RoomContext> {
    const empty: RoomContext = { messages: [], pendingProposals: [], approvedProposals: [] };
    if (!this.botState.roomId) return empty;
    try {
      const roomDoId = this._env.TRADING_ROOM.idFromName(this.botState.roomId);
      const roomStub = this._env.TRADING_ROOM.get(roomDoId);

      const [messagesResp, pendingResp, approvedResp] = await Promise.all([
        roomStub.fetch(new Request("https://internal/messages?limit=20", { method: "GET" })),
        roomStub.fetch(new Request("https://internal/proposals?status=PENDING", { method: "GET" })),
        roomStub.fetch(new Request("https://internal/proposals?status=APPROVED", { method: "GET" })),
      ]);

      const messagesData = (await messagesResp.json().catch(() => ({}))) as { messages?: AgentMessagePayload[] };
      const pendingData = (await pendingResp.json().catch(() => ({}))) as { proposals?: ProposalState[] };
      const approvedData = (await approvedResp.json().catch(() => ({}))) as { proposals?: ProposalState[] };

      return {
        messages: messagesData.messages ?? [],
        pendingProposals: pendingData.proposals ?? [],
        approvedProposals: approvedData.proposals ?? [],
      };
    } catch {
      return empty;
    }
  }

  /** Handle strategy-specific debate reactions (proposals, reviews, executions) */
  private async handleDebateReactions(
    signal: Signal,
    roomContext: RoomContext,
  ): Promise<void> {
    const strategyType = this.botState.strategyType;

    // Scraper/Twitter: emit PROPOSAL when signal confidence is high
    if (
      (strategyType === "POLYMARKET_SCRAPER" || strategyType === "POLYMARKET_TWITTER") &&
      signal.action !== "HOLD" &&
      signal.confidence >= 50
    ) {
      const proposalPayload: ProposalPayload = {
        proposalId: crypto.randomUUID(),
        action: signal.action,
        pair: signal.pair,
        rationale: signal.metadata.reason as string ?? "High-confidence signal",
        confidence: signal.confidence,
        data: signal.metadata,
      };
      await this.emitAgentMessage(
        `[PROPOSAL] ${signal.action} on ${signal.pair} — ${proposalPayload.rationale} (confidence: ${signal.confidence}%)`,
        "PROPOSAL",
        undefined,
        undefined,
        proposalPayload,
      );
    }

    // Reviewer: auto-review pending proposals this bot hasn't voted on
    if (strategyType === "POLYMARKET_REVIEWER") {
      for (const proposalState of roomContext.pendingProposals) {
        const alreadyVoted =
          proposalState.approvals.includes(this.botState.agentId) ||
          proposalState.rejections.includes(this.botState.agentId);
        if (alreadyVoted || proposalState.fromAgentId === this.botState.agentId) continue;

        // Find the original proposal message to reply to
        const proposalMsg = roomContext.messages.find(
          (m) => m.messageType === "PROPOSAL" && m.fromAgentId === proposalState.fromAgentId,
        );

        const { reviewProposal } = this.strategy as { reviewProposal?: (p: { proposalId: string; action: string; confidence: number; rationale: string }) => { approved: boolean; reason: string } };
        if (!reviewProposal) continue;

        const review = reviewProposal.call(this.strategy, {
          proposalId: proposalState.proposal.proposalId,
          action: proposalState.proposal.action,
          confidence: proposalState.proposal.confidence,
          rationale: proposalState.proposal.rationale,
        });

        await this.emitAgentMessage(
          `[${review.approved ? "APPROVE" : "REJECT"}] ${review.reason}`,
          review.approved ? "AGREEMENT" : "DISAGREEMENT",
          proposalState.fromAgentId,
          proposalMsg?.messageId,
        );
      }
    }

    // Executor: queue approved proposals for execution
    if (strategyType === "POLYMARKET_EXECUTOR") {
      for (const proposalState of roomContext.approvedProposals) {
        const proposalId = proposalState.proposal.proposalId;
        if (this.botState.executedProposalIds.includes(proposalId)) continue;

        const { queueExecution } = this.strategy as { queueExecution?: (id: string, action: string, confidence: number) => void };
        if (!queueExecution) continue;

        queueExecution.call(
          this.strategy,
          proposalId,
          proposalState.proposal.action,
          proposalState.proposal.confidence,
        );

        this.botState.executedProposalIds.push(proposalId);
        // Keep last 50
        if (this.botState.executedProposalIds.length > 50) {
          this.botState.executedProposalIds = this.botState.executedProposalIds.slice(-50);
        }

        await this.emitAgentMessage(
          `Queuing execution for approved proposal: ${proposalState.proposal.action} ${proposalState.proposal.pair}`,
          "STATUS_UPDATE",
        );
      }
    }
  }

  private async reportTradeEventToRoom(
    event: string,
    data: Record<string, unknown>,
  ): Promise<void> {
    if (!this.botState.roomId) return;
    try {
      const roomDoId = this._env.TRADING_ROOM.idFromName(this.botState.roomId);
      const roomStub = this._env.TRADING_ROOM.get(roomDoId);
      await roomStub.fetch(
        new Request("https://internal/notify", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            agentId: this.botState.agentId,
            tradeEvent: {
              event,
              data,
              timestamp: new Date().toISOString(),
            },
          }),
        }),
      );
    } catch (err) {
      console.error("Failed to report trade event to room:", err);
    }
  }

  /** Push full state to TradingRoom (used on start/stop) */
  private async reportStateToRoom(): Promise<void> {
    if (!this.botState.roomId) return;

    try {
      const roomDoId = this._env.TRADING_ROOM.idFromName(this.botState.roomId);
      const roomStub = this._env.TRADING_ROOM.get(roomDoId);

      await roomStub.fetch(
        new Request("https://internal/notify", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            agentId: this.botState.agentId,
            state: this.buildRealtimeState(),
          }),
        }),
      );
    } catch (err) {
      console.error("Failed to report state to room:", err);
    }
  }

  /** Push delta state to TradingRoom (used on each tick) */
  private async reportDeltaToRoom(): Promise<void> {
    if (!this.botState.roomId) return;

    try {
      const roomDoId = this._env.TRADING_ROOM.idFromName(this.botState.roomId);
      const roomStub = this._env.TRADING_ROOM.get(roomDoId);

      const changes: Partial<AgentRealtimeState> = {
        doId: this.ctx.id.toString(),
        state: this.botState.agentState,
        activity: this.botState.activity,
        currentThought: this.botState.currentThought,
        positions: this.botState.positions,
        pnlTotal: this.botState.pnlTotal,
        pnlToday: this.botState.pnlToday,
        tradeCountToday: this.botState.tradeCountToday,
        lastTradeAt: this.botState.lastTradeAt,
      };

      await roomStub.fetch(
        new Request("https://internal/notify", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            agentId: this.botState.agentId,
            changes,
          }),
        }),
      );
    } catch (err) {
      console.error("Failed to report delta to room:", err);
    }
  }

  private async scheduleNextTick(): Promise<void> {
    let interval = this.botState.tickIntervalMs;
    if (this.botState.consecutiveErrors > 0) {
      interval = Math.min(
        interval * Math.pow(2, this.botState.consecutiveErrors),
        60000,
      );
      console.log(
        `Backoff: scheduling next tick in ${interval}ms (consecutive errors: ${this.botState.consecutiveErrors})`,
      );
    }

    await this.ctx.storage.setAlarm(Date.now() + interval);
  }
}
