import { DurableObject } from "cloudflare:workers";
import type {
  AgentRealtimeState,
  ServerMessage,
  ClientMessage,
  FullStateMessage,
  StateDeltaMessage,
  ErrorMessage,
  RoomStateMessage,
  TradeEventMessage,
} from "@repo/types";

interface SessionMeta {
  id: string;
  subscriptions: Set<string>;
}

interface BotRegistryEntry {
  agentId: string;
  name: string;
  pair: string;
  doId: string;
  registeredAt: string;
}

interface RoomConfig {
  roomId: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  risk: {
    maxTotalExposureUsd: number;
    maxDailyRoomLossUsd: number;
  };
}

interface RoomMetrics {
  botCount: number;
  activeBotCount: number;
  totalPnl: number;
  totalPnlToday: number;
  totalExposure: number;
  riskStatus: "NORMAL" | "WARNING" | "BREACHED";
}

interface TradeEventPayload {
  event: string;
  data: Record<string, unknown>;
  timestamp: string;
}

interface EmergencyStopResult {
  agentId: string;
  doId: string;
  ok: boolean;
  status: number;
  message: string;
}

export class TradingRoom extends DurableObject {
  private readonly _env: Env;
  sessions: Map<WebSocket, SessionMeta>;
  /** Per-agent sequence numbers for ordered delivery */
  seqCounters: Map<string, number>;
  /** Cached bot states for FULL_STATE on connect/subscribe */
  botStates: Map<string, AgentRealtimeState>;
  private emergencyInProgress = false;

  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
    this._env = env;
    this.sessions = new Map();
    this.seqCounters = new Map();
    this.botStates = new Map();
  }

  private defaultRoomConfig(roomId = this.ctx.id.toString()): RoomConfig {
    const now = new Date().toISOString();
    return {
      roomId,
      name: roomId,
      createdAt: now,
      updatedAt: now,
      risk: {
        maxTotalExposureUsd: 10000,
        maxDailyRoomLossUsd: 1000,
      },
    };
  }

  private toPositiveNumber(value: unknown, fallback: number): number {
    const parsed =
      typeof value === "number"
        ? value
        : typeof value === "string"
          ? Number(value)
          : Number.NaN;
    if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
    return parsed;
  }

  private inferRoomIdFromPath(path: string): string | null {
    const match = path.match(/\/api\/room\/([^/]+)/);
    if (!match?.[1]) return null;
    return decodeURIComponent(match[1]);
  }

  private async loadRoomConfig(roomIdHint?: string): Promise<RoomConfig> {
    const config = await this.ctx.storage.get<RoomConfig>("roomConfig");
    if (config) {
      const internalId = this.ctx.id.toString();
      if (
        roomIdHint &&
        config.roomId !== roomIdHint &&
        config.roomId === internalId
      ) {
        const next: RoomConfig = {
          ...config,
          roomId: roomIdHint,
          name: config.name === internalId ? roomIdHint : config.name,
          updatedAt: new Date().toISOString(),
        };
        await this.saveRoomConfig(next);
        return next;
      }
      return config;
    }

    const roomId = roomIdHint ?? this.ctx.id.toString();
    const created = this.defaultRoomConfig(roomId);
    if (roomIdHint) {
      await this.saveRoomConfig(created);
    }
    return created;
  }

  private async saveRoomConfig(config: RoomConfig): Promise<void> {
    await this.ctx.storage.put("roomConfig", config);
  }

  private nextSeq(agentId: string): number {
    const current = this.seqCounters.get(agentId) ?? 0;
    const next = current + 1;
    this.seqCounters.set(agentId, next);
    return next;
  }

  private sendToWs(ws: WebSocket, msg: ServerMessage): void {
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      // Connection may have closed; will be cleaned up in webSocketClose
    }
  }

  private sendFullState(ws: WebSocket, agentId: string): void {
    const state = this.botStates.get(agentId);
    if (!state) return;

    const msg: FullStateMessage = {
      type: "FULL_STATE",
      agentId,
      seq: this.nextSeq(agentId),
      timestamp: new Date().toISOString(),
      state,
    };
    this.sendToWs(ws, msg);
  }

  private sendRoomState(
    ws: WebSocket,
    roomId: string,
    metrics: RoomMetrics,
  ): void {
    const msg: RoomStateMessage = {
      type: "ROOM_STATE",
      roomId,
      timestamp: new Date().toISOString(),
      ...metrics,
    };
    this.sendToWs(ws, msg);
  }

  private broadcastTradeEvent(
    agentId: string,
    payload: TradeEventPayload,
  ): void {
    const msg: TradeEventMessage = {
      type: "TRADE_EVENT",
      agentId,
      timestamp: payload.timestamp,
      event: payload.event,
      data: payload.data,
    };

    for (const [ws, meta] of this.sessions) {
      if (meta.subscriptions.has(agentId) || meta.subscriptions.size === 0) {
        this.sendToWs(ws, msg);
      }
    }
  }

  private async broadcastRoomState(): Promise<void> {
    const config = await this.loadRoomConfig();
    const metrics = this.computeRoomMetrics(config);
    for (const [ws] of this.sessions) {
      this.sendRoomState(ws, config.roomId, metrics);
    }
  }

  private computeRoomMetrics(config: RoomConfig): RoomMetrics {
    let totalPnl = 0;
    let totalPnlToday = 0;
    let totalExposure = 0;
    let activeBotCount = 0;

    for (const state of this.botStates.values()) {
      totalPnl += state.pnlTotal;
      totalPnlToday += state.pnlToday;
      if (state.state === "RUNNING") activeBotCount++;
      for (const pos of state.positions) {
        totalExposure += Math.abs(pos.size * pos.currentPrice);
      }
    }

    const maxExposure = Math.max(config.risk.maxTotalExposureUsd, 1);
    const maxDailyLoss = Math.max(config.risk.maxDailyRoomLossUsd, 1);
    const dailyLoss = Math.abs(Math.min(totalPnlToday, 0));
    const exposureRatio = totalExposure / maxExposure;
    const dailyLossRatio = dailyLoss / maxDailyLoss;

    let riskStatus: RoomMetrics["riskStatus"] = "NORMAL";
    if (exposureRatio >= 1 || dailyLossRatio >= 1) {
      riskStatus = "BREACHED";
    } else if (exposureRatio >= 0.8 || dailyLossRatio >= 0.8) {
      riskStatus = "WARNING";
    }

    return {
      botCount: this.botStates.size,
      activeBotCount,
      totalPnl,
      totalPnlToday,
      totalExposure,
      riskStatus,
    };
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const roomIdHint = this.inferRoomIdFromPath(path);

    // Ensure room slug is persisted when the request comes through /api/room/:id/*
    if (roomIdHint) {
      await this.loadRoomConfig(roomIdHint);
    }

    // POST /notify - internal endpoint for BotInstance state pushes
    if (request.method === "POST" && path.endsWith("/notify")) {
      return this.handleNotify(request);
    }

    // POST /register - register a bot in this room
    if (request.method === "POST" && path.endsWith("/register")) {
      return this.handleRegister(request);
    }

    // POST /configure - create/update room config
    if (request.method === "POST" && path.endsWith("/configure")) {
      return this.handleConfigure(request);
    }

    // GET /info - room info
    if (request.method === "GET" && path.endsWith("/info")) {
      return this.handleGetInfo(roomIdHint ?? undefined);
    }

    // POST /emergency-stop - emergency shutdown
    if (request.method === "POST" && path.endsWith("/emergency-stop")) {
      return this.handleEmergencyStop();
    }

    // WebSocket upgrade for /ws
    if (path.endsWith("/ws")) {
      const upgradeHeader = request.headers.get("Upgrade");
      if (!upgradeHeader || upgradeHeader !== "websocket") {
        return new Response("Expected Upgrade: websocket", { status: 426 });
      }
      return this.handleWebSocketUpgrade(roomIdHint ?? undefined);
    }

    return new Response("Not found", { status: 404 });
  }

  private async handleWebSocketUpgrade(roomIdHint?: string): Promise<Response> {
    const webSocketPair = new WebSocketPair();
    const [client, server] = Object.values(webSocketPair);

    this.ctx.acceptWebSocket(server);
    const sessionMeta: SessionMeta = {
      id: crypto.randomUUID(),
      subscriptions: new Set(),
    };
    this.sessions.set(server, sessionMeta);

    // Send FULL_STATE for every registered bot on connect
    for (const agentId of this.botStates.keys()) {
      this.sendFullState(server, agentId);
    }

    // Send room state
    const config = await this.loadRoomConfig(roomIdHint);
    const metrics = this.computeRoomMetrics(config);
    this.sendRoomState(server, config.roomId, metrics);

    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  }

  private async handleNotify(request: Request): Promise<Response> {
    const body = (await request.json()) as {
      agentId: string;
      state?: AgentRealtimeState;
      changes?: Partial<AgentRealtimeState>;
      tradeEvent?: TradeEventPayload;
    };

    const { agentId, state, changes, tradeEvent } = body;
    if (!agentId) {
      return Response.json(
        { ok: false, message: "agentId is required" },
        { status: 400 },
      );
    }

    // Full state push (e.g., on bot start)
    if (state) {
      this.botStates.set(agentId, state);
      // Broadcast FULL_STATE to subscribers
      for (const [ws, meta] of this.sessions) {
        if (meta.subscriptions.has(agentId) || meta.subscriptions.size === 0) {
          this.sendFullState(ws, agentId);
        }
      }
    }

    // Delta push (most common)
    if (changes) {
      const existing = this.botStates.get(agentId);
      if (existing) {
        // Merge changes into cached state
        Object.assign(existing, changes);
        this.botStates.set(agentId, existing);
      }
      this.broadcastDelta(agentId, changes);
    }

    if (tradeEvent) {
      this.broadcastTradeEvent(agentId, tradeEvent);
    }

    await this.broadcastRoomState();
    await this.maybeTriggerRiskStop();

    return Response.json({ ok: true });
  }

  private async handleRegister(request: Request): Promise<Response> {
    const body = (await request.json()) as {
      agentId: string;
      name: string;
      pair: string;
      doId: string;
    };
    if (!body.agentId || !body.doId) {
      return Response.json(
        { ok: false, message: "agentId and doId are required" },
        { status: 400 },
      );
    }

    // Load existing registry
    const registry =
      (await this.ctx.storage.get<BotRegistryEntry[]>("botRegistry")) ?? [];

    // Check if already registered
    const existing = registry.find((e) => e.agentId === body.agentId);
    if (existing) {
      existing.name = body.name || existing.name;
      existing.pair = body.pair || existing.pair;
      existing.doId = body.doId || existing.doId;
      await this.ctx.storage.put("botRegistry", registry);
      await this.broadcastRoomState();
      return Response.json({ ok: true, entry: existing, updated: true });
    }

    const entry: BotRegistryEntry = {
      agentId: body.agentId,
      name: body.name,
      pair: body.pair,
      doId: body.doId,
      registeredAt: new Date().toISOString(),
    };

    registry.push(entry);
    await this.ctx.storage.put("botRegistry", registry);
    await this.broadcastRoomState();

    return Response.json({ ok: true, entry });
  }

  private async handleConfigure(request: Request): Promise<Response> {
    const body = (await request.json()) as {
      roomId?: string;
      name?: string;
      risk?: {
        maxTotalExposureUsd?: number;
        maxDailyRoomLossUsd?: number;
      };
    };

    const existing = await this.loadRoomConfig(body.roomId);
    const roomId =
      typeof body.roomId === "string" && body.roomId.length > 0
        ? body.roomId
        : existing.roomId;
    const name =
      typeof body.name === "string" && body.name.length > 0
        ? body.name
        : existing.name;

    const next: RoomConfig = {
      roomId,
      name,
      createdAt: existing.createdAt,
      updatedAt: new Date().toISOString(),
      risk: {
        maxTotalExposureUsd: this.toPositiveNumber(
          body.risk?.maxTotalExposureUsd,
          existing.risk.maxTotalExposureUsd,
        ),
        maxDailyRoomLossUsd: this.toPositiveNumber(
          body.risk?.maxDailyRoomLossUsd,
          existing.risk.maxDailyRoomLossUsd,
        ),
      },
    };

    await this.saveRoomConfig(next);
    await this.broadcastRoomState();
    return Response.json({ ok: true, config: next });
  }

  private async handleGetInfo(roomIdHint?: string): Promise<Response> {
    const config = await this.loadRoomConfig(roomIdHint);
    const registry =
      (await this.ctx.storage.get<BotRegistryEntry[]>("botRegistry")) ?? [];
    const metrics = this.computeRoomMetrics(config);

    return Response.json({
      id: this.ctx.id.toString(),
      roomId: config.roomId,
      config,
      bots: registry,
      metrics,
    });
  }

  private async handleEmergencyStop(): Promise<Response> {
    const stopSummary = await this.performEmergencyStop("MANUAL_EMERGENCY_STOP");
    return Response.json(stopSummary);
  }

  private async maybeTriggerRiskStop(): Promise<void> {
    if (this.emergencyInProgress) return;
    const config = await this.loadRoomConfig();
    const metrics = this.computeRoomMetrics(config);
    if (metrics.riskStatus !== "BREACHED") return;
    await this.performEmergencyStop("ROOM_RISK_BREACH");
  }

  private async performEmergencyStop(reason: string): Promise<{
    ok: boolean;
    message: string;
    reason: string;
    botsAffected: number;
    results: EmergencyStopResult[];
  }> {
    if (this.emergencyInProgress) {
      return {
        ok: false,
        message: "Emergency stop already in progress",
        reason,
        botsAffected: 0,
        results: [],
      };
    }

    this.emergencyInProgress = true;
    const registry =
      (await this.ctx.storage.get<BotRegistryEntry[]>("botRegistry")) ?? [];
    const results: EmergencyStopResult[] = [];

    try {
      for (const entry of registry) {
        try {
          const botId = this._env.BOT_INSTANCE.idFromString(entry.doId);
          const botStub = this._env.BOT_INSTANCE.get(botId);
          const stopResponse = await botStub.fetch(
            new Request(
              `https://internal/api/bot/${encodeURIComponent(entry.agentId)}/stop`,
              { method: "POST" },
            ),
          );

          const payload = (await stopResponse
            .json()
            .catch(() => ({ message: "No response body" }))) as {
            ok?: boolean;
            message?: string;
          };

          const ok = stopResponse.ok && payload.ok !== false;
          results.push({
            agentId: entry.agentId,
            doId: entry.doId,
            ok,
            status: stopResponse.status,
            message:
              payload.message ??
              (ok ? "Bot stopped" : "Bot stop returned an error"),
          });

          if (ok) {
            const cached = this.botStates.get(entry.agentId);
            if (cached) {
              cached.state = "STOPPED";
              cached.activity = "IDLE";
              cached.currentThought = `Stopped by emergency stop (${reason})`;
              this.botStates.set(entry.agentId, cached);
            }
          }
        } catch (error) {
          results.push({
            agentId: entry.agentId,
            doId: entry.doId,
            ok: false,
            status: 500,
            message: String(error),
          });
        }
      }

      const failedCount = results.filter((r) => !r.ok).length;
      const summaryMessage =
        failedCount === 0
          ? "Emergency stop executed for all bots"
          : `Emergency stop completed with ${failedCount} failure(s)`;

      const errorMsg: ErrorMessage = {
        type: "ERROR",
        code: "EMERGENCY_STOP",
        message: `${summaryMessage}. Reason: ${reason}`,
      };

      for (const [ws] of this.sessions) {
        this.sendToWs(ws, errorMsg);
      }
      await this.broadcastRoomState();

      return {
        ok: failedCount === 0,
        message: summaryMessage,
        reason,
        botsAffected: registry.length,
        results,
      };
    } finally {
      this.emergencyInProgress = false;
    }
  }

  /** Broadcast a STATE_DELTA to all sessions subscribed to this agent */
  broadcastDelta(
    agentId: string,
    changes: Partial<AgentRealtimeState>,
  ): void {
    const msg: StateDeltaMessage = {
      type: "STATE_DELTA",
      agentId,
      seq: this.nextSeq(agentId),
      timestamp: new Date().toISOString(),
      changes,
    };

    for (const [ws, meta] of this.sessions) {
      // Send to sessions subscribed to this agent, or to sessions with no specific subscriptions (they get everything)
      if (meta.subscriptions.has(agentId) || meta.subscriptions.size === 0) {
        this.sendToWs(ws, msg);
      }
    }
  }

  async webSocketMessage(
    ws: WebSocket,
    message: string | ArrayBuffer,
  ): Promise<void> {
    const meta = this.sessions.get(ws);
    if (!meta) return;

    let parsed: ClientMessage;
    try {
      parsed = JSON.parse(
        typeof message === "string" ? message : new TextDecoder().decode(message),
      ) as ClientMessage;
    } catch {
      this.sendToWs(ws, {
        type: "ERROR",
        code: "INVALID_MESSAGE",
        message: "Failed to parse JSON message",
      });
      return;
    }

    switch (parsed.type) {
      case "SUBSCRIBE": {
        meta.subscriptions.add(parsed.agentId);
        // Send FULL_STATE for the newly subscribed agent
        this.sendFullState(ws, parsed.agentId);
        break;
      }

      case "UNSUBSCRIBE": {
        meta.subscriptions.delete(parsed.agentId);
        break;
      }

      case "PING": {
        this.sendToWs(ws, {
          type: "PONG",
          timestamp: new Date().toISOString(),
        });
        break;
      }

      default: {
        this.sendToWs(ws, {
          type: "ERROR",
          code: "UNKNOWN_MESSAGE_TYPE",
          message: `Unknown message type: ${(parsed as { type: string }).type}`,
        });
      }
    }
  }

  async webSocketClose(
    ws: WebSocket,
    _code: number,
    _reason: string,
    _wasClean: boolean,
  ): Promise<void> {
    this.sessions.delete(ws);
  }

  async webSocketError(ws: WebSocket, _error: unknown): Promise<void> {
    this.sessions.delete(ws);
  }
}
