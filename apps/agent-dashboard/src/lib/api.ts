import type { Position, PnlSummary } from "@repo/types";

const API_URL = (import.meta.env.VITE_API_URL || "").replace(/\/$/, "");

interface StatusResponse {
  status: string;
  timestamp: number;
  version: string;
}

interface BotStatusResponse {
  id: string;
  isRunning: boolean;
  agentState: string;
  activity: string;
  startedAt: number | null;
  tickCount: number;
  lastTick: number | null;
  lastDecision: Record<string, unknown> | null;
  currentThought: string | null;
  errors: number;
  consecutiveErrors: number;
  pair: string;
  positions: Position[];
  pnlTotal: number;
  pnlToday: number;
  tradeCountToday: number;
  strategy: string;
  strategyState: Record<string, unknown>;
  uptime: number;
}

interface BotLogsResponse {
  logs: LogEntry[];
}

interface LogEntry {
  timestamp: number;
  type: string;
  action?: string;
  signal?: Record<string, unknown>;
  decision?: {
    action?: string;
    pair?: string;
    confidence?: number;
    rationale?: string;
    asset?: string;
  };
  error?: string;
  strategy?: string;
  marketPrice?: number;
  consecutiveErrors?: number;
}

interface RoomInfo {
  id: string;
  roomId: string;
  config: Record<string, unknown> | null;
  bots: Array<{
    agentId: string;
    name: string;
    pair: string;
    doId: string;
    registeredAt: string;
  }>;
  metrics: {
    botCount: number;
    activeBotCount: number;
    totalPnl: number;
    totalPnlToday: number;
    totalExposure: number;
    riskStatus: string;
  };
}

interface CreateRoomResponse {
  ok: boolean;
  roomId: string;
  doId: string;
  config?: Record<string, unknown>;
}

interface CreateBotResponse {
  ok: boolean;
  botId: string;
  doId: string;
  roomId: string;
}

interface EmergencyStopResponse {
  ok: boolean;
  message: string;
  reason: string;
  botsAffected: number;
  results: Array<{
    agentId: string;
    doId: string;
    ok: boolean;
    status: number;
    message: string;
  }>;
}

export interface AiGatewayModelOption {
  id: string;
  label: string;
  model: string;
  provider: string;
  byokAlias?: string;
  isDefault: boolean;
  configured: boolean;
  status: "ready" | "missing_key" | "gateway_auth" | "invalid_model" | "error";
  message?: string;
}

export interface AiGatewayModelCatalog {
  ok: true;
  source: "env" | "gateway" | "default";
  checkedAt: string;
  models: AiGatewayModelOption[];
}

export interface MarketPairsCatalog {
  ok: true;
  source: "hyperliquid" | "fallback";
  testnet: boolean;
  updatedAt: string;
  pairs: string[];
  message?: string;
}

function buildUrl(path: string): string {
  if (API_URL) return `${API_URL}${path}`;
  return path;
}

async function requestJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(buildUrl(path), {
    ...init,
    headers: init.headers,
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`API ${response.status}: ${body || response.statusText}`);
  }

  return response.json() as Promise<T>;
}

function botPath(botId: string, roomId?: string): string {
  const encodedBotId = encodeURIComponent(botId);
  if (roomId) {
    const encodedRoomId = encodeURIComponent(roomId);
    return `/api/room/${encodedRoomId}/bot/${encodedBotId}`;
  }
  return `/api/bot/${encodedBotId}`;
}

export const api = {
  // --- System ---

  async getStatus(): Promise<StatusResponse> {
    return requestJson<StatusResponse>("/api/status");
  },

  async getAiModels(refresh = false): Promise<AiGatewayModelCatalog> {
    const suffix = refresh ? "?refresh=1" : "";
    return requestJson<AiGatewayModelCatalog>(`/api/ai/models${suffix}`);
  },

  async getMarketPairs(refresh = false): Promise<MarketPairsCatalog> {
    const suffix = refresh ? "?refresh=1" : "";
    return requestJson<MarketPairsCatalog>(`/api/market/pairs${suffix}`);
  },

  // --- Room Management ---

  async createRoom(
    name: string,
    risk?: { maxTotalExposureUsd?: number; maxDailyRoomLossUsd?: number },
  ): Promise<CreateRoomResponse> {
    return requestJson<CreateRoomResponse>("/api/room", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, risk }),
    });
  },

  async getRoomInfo(roomId: string): Promise<RoomInfo> {
    return requestJson<RoomInfo>(`/api/room/${roomId}/info`);
  },

  async emergencyStop(roomId: string): Promise<EmergencyStopResponse> {
    return requestJson<EmergencyStopResponse>(`/api/room/${roomId}/emergency-stop`, {
      method: "POST",
    });
  },

  // --- Bot Management ---

  async createBotInRoom(
    roomId: string,
    name: string,
    config?: Record<string, unknown>,
  ): Promise<CreateBotResponse> {
    return requestJson<CreateBotResponse>(`/api/room/${roomId}/bot`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, config }),
    });
  },

  async getBotStatus(botId: string, roomId?: string): Promise<BotStatusResponse> {
    return requestJson<BotStatusResponse>(`${botPath(botId, roomId)}/status`);
  },

  async getBotLogs(botId: string, roomId?: string): Promise<BotLogsResponse> {
    return requestJson<BotLogsResponse>(`${botPath(botId, roomId)}/logs`);
  },

  async startBot(
    botId: string,
    config?: Record<string, unknown>,
    roomId?: string,
  ): Promise<{ ok: boolean; message: string }> {
    return requestJson<{ ok: boolean; message: string }>(`${botPath(botId, roomId)}/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: config ? JSON.stringify(config) : undefined,
    });
  },

  async stopBot(botId: string, roomId?: string): Promise<{ ok: boolean; message: string }> {
    return requestJson<{ ok: boolean; message: string }>(`${botPath(botId, roomId)}/stop`, {
      method: "POST",
    });
  },

  async pauseBot(botId: string, roomId?: string): Promise<{ ok: boolean; message: string }> {
    return requestJson<{ ok: boolean; message: string }>(`${botPath(botId, roomId)}/pause`, {
      method: "POST",
    });
  },

  async getBotPositions(botId: string, roomId?: string): Promise<{ positions: Position[] }> {
    return requestJson<{ positions: Position[] }>(`${botPath(botId, roomId)}/positions`);
  },

  async getBotPnl(botId: string, roomId?: string): Promise<PnlSummary> {
    return requestJson<PnlSummary>(`${botPath(botId, roomId)}/pnl`);
  },

  async updateBotConfig(
    botId: string,
    config: Record<string, unknown>,
    roomId?: string,
  ): Promise<{ ok: boolean; message: string }> {
    return requestJson<{ ok: boolean; message: string }>(`${botPath(botId, roomId)}/config`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(config),
    });
  },
};
