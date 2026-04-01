import { Hono } from "hono";
import { TradingRoom } from "./durable-objects/TradingRoom";
import { BotInstance } from "./durable-objects/BotInstance";
import { cors } from "hono/cors";
import { getAiModelCatalog } from "./ai/modelCatalog";
import { HyperliquidClient, SUPPORTED_PAIRS } from "@repo/hyperliquid-sdk";

// Export DO classes so Cloudflare can find them
export { TradingRoom, BotInstance };

const app = new Hono<{ Bindings: Env }>();
const GATEWAY_PASSWORD_HEADER = "x-openclaw-gateway-password";

interface RoomRegistryEntry {
  agentId: string;
  pair?: string;
}

interface RoomInfoResponse {
  bots?: RoomRegistryEntry[];
}

interface BotStatusResponse {
  isRunning?: boolean;
  agentState?: string;
  pair?: string;
}

interface MarketPairsResponse {
  ok: true;
  source: "hyperliquid" | "fallback";
  testnet: boolean;
  updatedAt: string;
  pairs: string[];
  message?: string;
}

type MarketPairsCache = {
  key: string;
  expiresAt: number;
  data: MarketPairsResponse;
};

const MARKET_PAIRS_TTL_MS = 60_000;
let marketPairsCache: MarketPairsCache | null = null;

function normalizePair(value: string | null | undefined): string {
  if (!value) return "";
  return value.trim().toUpperCase();
}

function isRunningStatus(status: BotStatusResponse | null): boolean {
  if (!status) return false;
  return status.isRunning === true || status.agentState === "RUNNING";
}

async function loadRoomInfo(env: Env, roomId: string): Promise<RoomInfoResponse | null> {
  try {
    const roomDoId = env.TRADING_ROOM.idFromName(roomId);
    const roomStub = env.TRADING_ROOM.get(roomDoId);
    const response = await roomStub.fetch(
      new Request("https://internal/info", { method: "GET" }),
    );
    if (!response.ok) return null;
    return await response.json<RoomInfoResponse>();
  } catch {
    return null;
  }
}

async function loadBotStatus(env: Env, botId: string): Promise<BotStatusResponse | null> {
  try {
    const doId = env.BOT_INSTANCE.idFromName(botId);
    const stub = env.BOT_INSTANCE.get(doId);
    const response = await stub.fetch(
      new Request(`https://internal/api/bot/${encodeURIComponent(botId)}/status`, {
        method: "GET",
      }),
    );
    if (!response.ok) return null;
    return await response.json<BotStatusResponse>();
  } catch {
    return null;
  }
}

async function findRunningBotByPair(
  env: Env,
  roomId: string,
  pair: string,
  excludeAgentId?: string,
): Promise<{ agentId: string; pair: string } | null> {
  const targetPair = normalizePair(pair);
  if (!targetPair) return null;

  const roomInfo = await loadRoomInfo(env, roomId);
  const bots = roomInfo?.bots ?? [];

  for (const bot of bots) {
    if (excludeAgentId && bot.agentId === excludeAgentId) {
      continue;
    }

    const status = await loadBotStatus(env, bot.agentId);
    if (!isRunningStatus(status)) {
      continue;
    }

    const statusPair = normalizePair(status?.pair || bot.pair);
    if (statusPair && statusPair === targetPair) {
      return { agentId: bot.agentId, pair: statusPair };
    }
  }

  return null;
}

function extractRequestedPairFromStartBody(body: Record<string, unknown>): string | null {
  if (typeof body.pair === "string" && body.pair.trim().length > 0) {
    return normalizePair(body.pair);
  }

  const config =
    body.config && typeof body.config === "object"
      ? (body.config as Record<string, unknown>)
      : null;

  if (config && typeof config.pair === "string" && config.pair.trim().length > 0) {
    return normalizePair(config.pair);
  }

  const trading =
    config?.trading && typeof config.trading === "object"
      ? (config.trading as Record<string, unknown>)
      : null;
  const pairs = Array.isArray(trading?.pairs) ? trading?.pairs : [];
  const firstPair = typeof pairs?.[0] === "string" ? normalizePair(pairs[0]) : "";
  if (firstPair) return firstPair;

  return null;
}

async function getMarketPairs(
  env: Env,
  options?: { refresh?: boolean },
): Promise<MarketPairsResponse> {
  const refresh = options?.refresh === true;
  const testnet = env.HYPERLIQUID_TESTNET === "true";
  const key = testnet ? "testnet" : "mainnet";
  const now = Date.now();
  if (
    !refresh &&
    marketPairsCache &&
    marketPairsCache.key === key &&
    marketPairsCache.expiresAt > now
  ) {
    return marketPairsCache.data;
  }

  let data: MarketPairsResponse;
  try {
    const client = new HyperliquidClient({ testnet });
    const meta = await client.getMeta();
    const pairs = meta.universe
      .map((asset) => normalizePair(asset.name))
      .filter((pair): pair is string => pair.length > 0)
      .sort((a, b) => a.localeCompare(b));

    if (pairs.length === 0) {
      throw new Error("Hyperliquid returned an empty universe");
    }

    data = {
      ok: true,
      source: "hyperliquid",
      testnet,
      updatedAt: new Date().toISOString(),
      pairs,
    };
  } catch (error) {
    data = {
      ok: true,
      source: "fallback",
      testnet,
      updatedAt: new Date().toISOString(),
      pairs: [...SUPPORTED_PAIRS],
      message: `Using fallback pair list: ${String(error)}`,
    };
  }

  marketPairsCache = {
    key,
    expiresAt: now + MARKET_PAIRS_TTL_MS,
    data,
  };
  return data;
}

function extractGatewayPassword(request: Request): string | null {
  const headerValue = request.headers.get(GATEWAY_PASSWORD_HEADER);
  if (headerValue && headerValue.length > 0) {
    return headerValue;
  }

  const authHeader = request.headers.get("authorization");
  if (authHeader && authHeader.startsWith("Bearer ")) {
    return authHeader.slice("Bearer ".length).trim();
  }

  const url = new URL(request.url);
  const queryPassword = url.searchParams.get("gateway_password");
  if (queryPassword && queryPassword.length > 0) {
    return queryPassword;
  }

  return null;
}

function buildStartForwardBody(
  rawBody: string,
  defaultRoomId: string,
): { ok: true; body: Record<string, unknown> } | { ok: false; response: Response } {
  let parsedBody: Record<string, unknown> = {};
  if (rawBody.trim().length > 0) {
    try {
      parsedBody = JSON.parse(rawBody) as Record<string, unknown>;
    } catch {
      return {
        ok: false,
        response: Response.json({
          ok: false,
          error: "INVALID_JSON",
          message: "Request body must be valid JSON",
        }, { status: 400 }),
      };
    }
  }

  const config =
    parsedBody.config && typeof parsedBody.config === "object"
      ? { ...(parsedBody.config as Record<string, unknown>) }
      : {};

  if (typeof parsedBody.roomId === "string" && !config.roomId) {
    config.roomId = parsedBody.roomId;
  }
  if (typeof parsedBody.pair === "string" && !config.pair) {
    config.pair = parsedBody.pair;
  }
  if (!config.roomId) {
    config.roomId = defaultRoomId;
  }

  return {
    ok: true,
    body: {
      ...parsedBody,
      roomId: config.roomId,
      config,
    },
  };
}

async function resolveBotIdForRoom(
  env: Env,
  roomId: string,
  botIdOrAlias: string,
): Promise<string> {
  try {
    const roomInfo = await loadRoomInfo(env, roomId);
    if (!roomInfo) return botIdOrAlias;
    const bots = roomInfo.bots ?? [];
    if (bots.length === 0) return botIdOrAlias;

    const exact = bots.find((entry) => entry.agentId === botIdOrAlias);
    if (exact) return exact.agentId;

    const lowered = botIdOrAlias.toLowerCase();
    const suffix = bots.find((entry) =>
      entry.agentId.toLowerCase().endsWith(`-${lowered}`),
    );
    if (suffix) return suffix.agentId;
  } catch {
    // Fall back to the provided ID/alias.
  }

  return botIdOrAlias;
}

app.use("/*", cors({
  origin: ["http://localhost:5173", "https://openclaw-village.pages.dev", "https://openclaw-agent-dashboard.pages.dev"],
  allowMethods: ["POST", "GET", "PUT", "DELETE", "OPTIONS"],
  allowHeaders: ["Content-Type", "Upgrade", "Authorization", "x-openclaw-gateway-password"],
  exposeHeaders: ["Content-Length"],
  maxAge: 600,
  credentials: true,
}));

app.use("/api/*", async (c, next) => {
  if (c.req.method === "OPTIONS") {
    return next();
  }

  const expected = c.env.OPENCLAW_GATEWAY_PASSWORD?.trim();
  if (!expected) {
    return c.json({
      ok: false,
      error: "AUTH_MISCONFIGURED",
      message: "OPENCLAW_GATEWAY_PASSWORD is not configured",
    }, 503);
  }

  const provided = extractGatewayPassword(c.req.raw);
  if (!provided || provided !== expected) {
    return c.json({
      ok: false,
      error: "UNAUTHORIZED",
      message: "Invalid or missing gateway password",
    }, 401);
  }

  return next();
});

app.get("/", (c) => {
  return c.json({ status: "ok", service: "OpenClaw Village Agent API" });
});

// === Status API ===
app.get("/api/status", async (c) => {
  return c.json({
    status: "online",
    timestamp: Date.now(),
    version: "0.2.0",
  });
});

app.get("/api/ai/models", async (c) => {
  const refresh = c.req.query("refresh");
  const response = await getAiModelCatalog(c.env, {
    refresh: refresh === "1" || refresh === "true",
  });
  return c.json(response);
});

app.get("/api/market/pairs", async (c) => {
  const refresh = c.req.query("refresh");
  const response = await getMarketPairs(c.env, {
    refresh: refresh === "1" || refresh === "true",
  });
  return c.json(response);
});

// === Room Management ===

/** Create a new TradingRoom */
app.post("/api/room", async (c) => {
  const body = await c.req.json<{
    name: string;
    risk?: {
      maxTotalExposureUsd?: number;
      maxDailyRoomLossUsd?: number;
    };
  }>();

  const roomId = body.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  if (!roomId) {
    return c.json({
      ok: false,
      error: "INVALID_ROOM_ID",
      message: "Room name must contain at least one alphanumeric character",
    }, 400);
  }

  const id = c.env.TRADING_ROOM.idFromName(roomId);
  const stub = c.env.TRADING_ROOM.get(id);

  // Initialize room config via internal fetch
  const configResponse = await stub.fetch(
    new Request("https://internal/configure", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        roomId,
        name: body.name || roomId,
        risk: body.risk,
      }),
    }),
  );
  const configured = await configResponse.json<{ config: unknown }>();

  return c.json({
    ok: true,
    roomId,
    doId: id.toString(),
    config: configured.config,
  });
});

/** Get room info */
app.get("/api/room/:id/info", async (c) => {
  const roomId = c.req.param("id");
  const id = c.env.TRADING_ROOM.idFromName(roomId);
  const stub = c.env.TRADING_ROOM.get(id);

  const resp = await stub.fetch(
    new Request("https://internal/info", { method: "GET" }),
  );
  const data = await resp.json();
  return c.json(data);
});

/** Emergency stop all bots in a room */
app.post("/api/room/:id/emergency-stop", async (c) => {
  const roomId = c.req.param("id");
  const id = c.env.TRADING_ROOM.idFromName(roomId);
  const stub = c.env.TRADING_ROOM.get(id);

  const resp = await stub.fetch(
    new Request("https://internal/emergency-stop", { method: "POST" }),
  );
  const data = await resp.json();
  return c.json(data);
});

/** Post a conversation message to a room */
app.post("/api/room/:id/message", async (c) => {
  const roomId = c.req.param("id");
  const id = c.env.TRADING_ROOM.idFromName(roomId);
  const stub = c.env.TRADING_ROOM.get(id);

  const resp = await stub.fetch(
    new Request("https://internal/message", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: await c.req.text(),
    }),
  );
  return c.json(await resp.json());
});

/** Get recent conversation messages for a room */
app.get("/api/room/:id/messages", async (c) => {
  const roomId = c.req.param("id");
  const id = c.env.TRADING_ROOM.idFromName(roomId);
  const stub = c.env.TRADING_ROOM.get(id);

  const limit = c.req.query("limit") ?? "50";
  const resp = await stub.fetch(
    new Request(`https://internal/messages?limit=${limit}`, {
      method: "GET",
    }),
  );
  return c.json(await resp.json());
});

/** Get proposals for a room (Phase 3) */
app.get("/api/room/:id/proposals", async (c) => {
  const roomId = c.req.param("id");
  const id = c.env.TRADING_ROOM.idFromName(roomId);
  const stub = c.env.TRADING_ROOM.get(id);

  const status = c.req.query("status") ?? "PENDING";
  const resp = await stub.fetch(
    new Request(`https://internal/proposals?status=${status}`, {
      method: "GET",
    }),
  );
  return c.json(await resp.json());
});

/** Serve voice audio files from R2 (Phase 2) */
app.get("/api/voice/:file", async (c) => {
  const file = c.req.param("file");
  const key = `voice/${file}`;
  const object = await c.env.OPENCLAW_DATA.get(key);

  if (!object) {
    return c.text("Not found", 404);
  }

  const headers = new Headers();
  headers.set("Content-Type", "audio/mpeg");
  headers.set("Cache-Control", "public, max-age=3600");
  return new Response(object.body, { headers });
});

/** WebSocket upgrade for a room */
app.get("/api/room/:id/ws", async (c) => {
  const roomId = c.req.param("id");
  const id = c.env.TRADING_ROOM.idFromName(roomId);
  const stub = c.env.TRADING_ROOM.get(id);

  // Forward the raw request to the DO for WebSocket upgrade
  return stub.fetch(c.req.raw);
});

// === Bot Management ===

/** Create and register a bot in a room */
app.post("/api/room/:roomId/bot", async (c) => {
  const roomId = c.req.param("roomId");
  const body = await c.req.json<{
    name: string;
    config?: {
      strategy?: { type?: string; params?: Record<string, unknown> };
      trading?: { pairs?: string[] };
      risk?: Record<string, unknown>;
      reasoning?: {
        model?: string;
        byokAlias?: string;
        intervalSeconds?: number;
        temperature?: number;
        maxTokens?: number;
      };
    };
  }>();

  const botName = body.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

  // Create the bot DO
  const botDoId = c.env.BOT_INSTANCE.idFromName(botName);
  const botStub = c.env.BOT_INSTANCE.get(botDoId);
  const initialPair = normalizePair(body.config?.trading?.pairs?.[0] ?? "ETH");

  const activePairConflict = await findRunningBotByPair(c.env, roomId, initialPair);
  if (activePairConflict) {
    return c.json({
      ok: false,
      error: "PAIR_ALREADY_ACTIVE",
      message:
        `Pair ${activePairConflict.pair} is already active in bot ` +
        `"${activePairConflict.agentId}". Stop it before creating another bot on this pair.`,
    }, 409);
  }

  const initialConfig: Record<string, unknown> = {
    roomId,
    pair: initialPair,
  };
  if (body.config) {
    Object.assign(initialConfig, body.config);
  }
  initialConfig.pair = initialPair;
  if (initialConfig.trading && typeof initialConfig.trading === "object") {
    const trading = {
      ...(initialConfig.trading as Record<string, unknown>),
      pairs: [initialPair],
    };
    initialConfig.trading = trading;
  }

  const configUrl = new URL(c.req.url);
  configUrl.pathname = `/api/bot/${botName}/config`;
  const configResponse = await botStub.fetch(
    new Request(configUrl.toString(), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ config: initialConfig }),
    }),
  );

  if (!configResponse.ok) {
    const detail = await configResponse.text().catch(() => "");
    return c.json({
      ok: false,
      error: "BOT_CONFIG_FAILED",
      message: detail || "Failed to configure bot before room registration",
    }, 502);
  }

  // Register bot in the room
  const roomDoId = c.env.TRADING_ROOM.idFromName(roomId);
  const roomStub = c.env.TRADING_ROOM.get(roomDoId);

  await roomStub.fetch(
    new Request("https://internal/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agentId: botName,
        name: body.name,
        pair: initialPair,
        doId: botDoId.toString(),
      }),
    }),
  );

  return c.json({
    ok: true,
    botId: botName,
    doId: botDoId.toString(),
    roomId,
  });
});

app.post("/api/room/:roomId/bot/:id/start", async (c) => {
  const roomId = c.req.param("roomId");
  const botAlias = c.req.param("id");
  const botId = await resolveBotIdForRoom(c.env, roomId, botAlias);
  const doId = c.env.BOT_INSTANCE.idFromName(botId);
  const stub = c.env.BOT_INSTANCE.get(doId);
  const url = new URL(c.req.url);
  url.pathname = `/api/bot/${botId}/start`;

  const rawBody = await c.req.text();
  const normalized = buildStartForwardBody(rawBody, roomId);
  if (!normalized.ok) {
    return normalized.response;
  }

  let requestedPair = extractRequestedPairFromStartBody(normalized.body);
  if (!requestedPair) {
    const status = await loadBotStatus(c.env, botId);
    requestedPair = normalizePair(status?.pair ?? "ETH");
  }

  const activePairConflict = await findRunningBotByPair(
    c.env,
    roomId,
    requestedPair,
    botId,
  );
  if (activePairConflict) {
    return c.json({
      ok: false,
      error: "PAIR_ALREADY_ACTIVE",
      message:
        `Pair ${activePairConflict.pair} is already active in bot ` +
        `"${activePairConflict.agentId}". Stop it before starting another bot on this pair.`,
    }, 409);
  }

  const forwardBody: Record<string, unknown> = {
    ...normalized.body,
  };
  const config =
    forwardBody.config && typeof forwardBody.config === "object"
      ? { ...(forwardBody.config as Record<string, unknown>) }
      : {};
  config.pair = requestedPair;
  if (config.trading && typeof config.trading === "object") {
    config.trading = {
      ...(config.trading as Record<string, unknown>),
      pairs: [requestedPair],
    };
  }
  forwardBody.config = config;
  forwardBody.pair = requestedPair;

  return stub.fetch(
    new Request(url.toString(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(forwardBody),
    }),
  );
});

app.post("/api/room/:roomId/bot/:id/stop", async (c) => {
  const roomId = c.req.param("roomId");
  const botAlias = c.req.param("id");
  const botId = await resolveBotIdForRoom(c.env, roomId, botAlias);
  const doId = c.env.BOT_INSTANCE.idFromName(botId);
  const stub = c.env.BOT_INSTANCE.get(doId);
  const url = new URL(c.req.url);
  url.pathname = `/api/bot/${botId}/stop`;
  return stub.fetch(new Request(url.toString(), { method: "POST" }));
});

app.post("/api/room/:roomId/bot/:id/pause", async (c) => {
  const roomId = c.req.param("roomId");
  const botAlias = c.req.param("id");
  const botId = await resolveBotIdForRoom(c.env, roomId, botAlias);
  const doId = c.env.BOT_INSTANCE.idFromName(botId);
  const stub = c.env.BOT_INSTANCE.get(doId);
  const url = new URL(c.req.url);
  url.pathname = `/api/bot/${botId}/pause`;
  return stub.fetch(new Request(url.toString(), { method: "POST" }));
});

app.get("/api/room/:roomId/bot/:id/status", async (c) => {
  const roomId = c.req.param("roomId");
  const botAlias = c.req.param("id");
  const botId = await resolveBotIdForRoom(c.env, roomId, botAlias);
  const doId = c.env.BOT_INSTANCE.idFromName(botId);
  const stub = c.env.BOT_INSTANCE.get(doId);
  const url = new URL(c.req.url);
  url.pathname = `/api/bot/${botId}/status`;
  return stub.fetch(new Request(url.toString()));
});

app.get("/api/room/:roomId/bot/:id/logs", async (c) => {
  const roomId = c.req.param("roomId");
  const botAlias = c.req.param("id");
  const botId = await resolveBotIdForRoom(c.env, roomId, botAlias);
  const doId = c.env.BOT_INSTANCE.idFromName(botId);
  const stub = c.env.BOT_INSTANCE.get(doId);
  const url = new URL(c.req.url);
  url.pathname = `/api/bot/${botId}/logs`;
  return stub.fetch(new Request(url.toString()));
});

app.get("/api/room/:roomId/bot/:id/positions", async (c) => {
  const roomId = c.req.param("roomId");
  const botAlias = c.req.param("id");
  const botId = await resolveBotIdForRoom(c.env, roomId, botAlias);
  const doId = c.env.BOT_INSTANCE.idFromName(botId);
  const stub = c.env.BOT_INSTANCE.get(doId);
  const url = new URL(c.req.url);
  url.pathname = `/api/bot/${botId}/positions`;
  return stub.fetch(new Request(url.toString()));
});

app.get("/api/room/:roomId/bot/:id/pnl", async (c) => {
  const roomId = c.req.param("roomId");
  const botAlias = c.req.param("id");
  const botId = await resolveBotIdForRoom(c.env, roomId, botAlias);
  const doId = c.env.BOT_INSTANCE.idFromName(botId);
  const stub = c.env.BOT_INSTANCE.get(doId);
  const url = new URL(c.req.url);
  url.pathname = `/api/bot/${botId}/pnl`;
  return stub.fetch(new Request(url.toString()));
});

app.put("/api/room/:roomId/bot/:id/config", async (c) => {
  const roomId = c.req.param("roomId");
  const botAlias = c.req.param("id");
  const botId = await resolveBotIdForRoom(c.env, roomId, botAlias);
  const doId = c.env.BOT_INSTANCE.idFromName(botId);
  const stub = c.env.BOT_INSTANCE.get(doId);
  const url = new URL(c.req.url);
  url.pathname = `/api/bot/${botId}/config`;
  return stub.fetch(
    new Request(url.toString(), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: await c.req.text(),
    }),
  );
});

app.post("/api/bot/:id/start", async (c) => {
  const botId = c.req.param("id");
  const id = c.env.BOT_INSTANCE.idFromName(botId);
  const stub = c.env.BOT_INSTANCE.get(id);
  const url = new URL(c.req.url);
  url.pathname = `/api/bot/${botId}/start`;

  const rawBody = await c.req.text();
  const normalized = buildStartForwardBody(rawBody, "main");
  if (!normalized.ok) {
    return normalized.response;
  }

  return stub.fetch(
    new Request(url.toString(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(normalized.body),
    }),
  );
});

app.post("/api/bot/:id/stop", async (c) => {
  const botId = c.req.param("id");
  const id = c.env.BOT_INSTANCE.idFromName(botId);
  const stub = c.env.BOT_INSTANCE.get(id);
  const url = new URL(c.req.url);
  url.pathname = `/api/bot/${botId}/stop`;
  return stub.fetch(new Request(url.toString(), { method: "POST" }));
});

app.post("/api/bot/:id/pause", async (c) => {
  const botId = c.req.param("id");
  const id = c.env.BOT_INSTANCE.idFromName(botId);
  const stub = c.env.BOT_INSTANCE.get(id);
  const url = new URL(c.req.url);
  url.pathname = `/api/bot/${botId}/pause`;
  return stub.fetch(new Request(url.toString(), { method: "POST" }));
});

app.get("/api/bot/:id/status", async (c) => {
  const botId = c.req.param("id");
  const id = c.env.BOT_INSTANCE.idFromName(botId);
  const stub = c.env.BOT_INSTANCE.get(id);
  const url = new URL(c.req.url);
  url.pathname = `/api/bot/${botId}/status`;
  return stub.fetch(new Request(url.toString()));
});

app.get("/api/bot/:id/logs", async (c) => {
  const botId = c.req.param("id");
  const id = c.env.BOT_INSTANCE.idFromName(botId);
  const stub = c.env.BOT_INSTANCE.get(id);
  const url = new URL(c.req.url);
  url.pathname = `/api/bot/${botId}/logs`;
  return stub.fetch(new Request(url.toString()));
});

app.get("/api/bot/:id/positions", async (c) => {
  const botId = c.req.param("id");
  const id = c.env.BOT_INSTANCE.idFromName(botId);
  const stub = c.env.BOT_INSTANCE.get(id);
  const url = new URL(c.req.url);
  url.pathname = `/api/bot/${botId}/positions`;
  return stub.fetch(new Request(url.toString()));
});

app.get("/api/bot/:id/pnl", async (c) => {
  const botId = c.req.param("id");
  const id = c.env.BOT_INSTANCE.idFromName(botId);
  const stub = c.env.BOT_INSTANCE.get(id);
  const url = new URL(c.req.url);
  url.pathname = `/api/bot/${botId}/pnl`;
  return stub.fetch(new Request(url.toString()));
});

app.put("/api/bot/:id/config", async (c) => {
  const botId = c.req.param("id");
  const id = c.env.BOT_INSTANCE.idFromName(botId);
  const stub = c.env.BOT_INSTANCE.get(id);
  const url = new URL(c.req.url);
  url.pathname = `/api/bot/${botId}/config`;

  return stub.fetch(
    new Request(url.toString(), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: await c.req.text(),
    }),
  );
});

export default app;
