import { Hono } from "hono";
import { TradingRoom } from "./durable-objects/TradingRoom";
import { BotInstance } from "./durable-objects/BotInstance";
import { cors } from "hono/cors";

// Export DO classes so Cloudflare can find them
export { TradingRoom, BotInstance };

const app = new Hono<{ Bindings: Env }>();
const GATEWAY_PASSWORD_HEADER = "x-openclaw-gateway-password";

interface RoomRegistryEntry {
  agentId: string;
}

interface RoomInfoResponse {
  bots?: RoomRegistryEntry[];
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
    const roomDoId = env.TRADING_ROOM.idFromName(roomId);
    const roomStub = env.TRADING_ROOM.get(roomDoId);
    const response = await roomStub.fetch(
      new Request("https://internal/info", { method: "GET" }),
    );
    if (!response.ok) return botIdOrAlias;

    const roomInfo = await response.json<RoomInfoResponse>();
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
  return c.json({ status: "ok", service: "OpenClaw Village Engine API" });
});

// === Status API ===
app.get("/api/status", async (c) => {
  return c.json({
    status: "online",
    timestamp: Date.now(),
    version: "0.2.0",
  });
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
      reasoning?: { intervalSeconds?: number };
    };
  }>();

  const botName = body.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

  // Create the bot DO
  const botDoId = c.env.BOT_INSTANCE.idFromName(botName);

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
        pair: body.config?.trading?.pairs?.[0] ?? "ETH",
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

  return stub.fetch(
    new Request(url.toString(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(normalized.body),
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
