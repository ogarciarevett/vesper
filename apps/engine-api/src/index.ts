import { Hono } from "hono";
import { GameRoom } from "./durable-objects/GameRoom";
import { BotInstance } from "./durable-objects/BotInstance";
import { cors } from "hono/cors";

// Export DO classes so Cloudflare can find them
export { GameRoom, BotInstance };

const app = new Hono<{ Bindings: Env }>();

app.use("/*", cors({
  origin: ["http://localhost:5173", "https://openclaw-village.pages.dev", "https://openclaw-mission-control.pages.dev"],
  allowMethods: ["POST", "GET", "OPTIONS"],
  allowHeaders: ["Content-Type", "Upgrade"],
  exposeHeaders: ["Content-Length"],
  maxAge: 600,
  credentials: true,
}));

app.get("/", (c) => {
  return c.json({ status: "ok", service: "OpenClaw Village Engine API" });
});

// === Status API ===
app.get("/api/status", async (c) => {
  // Return overall system status
  return c.json({
    status: "online",
    timestamp: Date.now(),
    version: "0.1.0",
  });
});

// === Bot Management ===
app.post("/api/bot/:id/start", async (c) => {
  const id = c.env.BOT_INSTANCE.idFromName(c.req.param("id"));
  const stub = c.env.BOT_INSTANCE.get(id);
  const url = new URL(c.req.url);
  url.pathname = `/api/bot/${c.req.param("id")}/start`;
  return stub.fetch(new Request(url.toString()));
});

app.post("/api/bot/:id/stop", async (c) => {
  const id = c.env.BOT_INSTANCE.idFromName(c.req.param("id"));
  const stub = c.env.BOT_INSTANCE.get(id);
  const url = new URL(c.req.url);
  url.pathname = `/api/bot/${c.req.param("id")}/stop`;
  return stub.fetch(new Request(url.toString()));
});

app.get("/api/bot/:id/status", async (c) => {
  const id = c.env.BOT_INSTANCE.idFromName(c.req.param("id"));
  const stub = c.env.BOT_INSTANCE.get(id);
  const url = new URL(c.req.url);
  url.pathname = `/api/bot/${c.req.param("id")}/status`;
  return stub.fetch(new Request(url.toString()));
});

app.get("/api/bot/:id/logs", async (c) => {
  const id = c.env.BOT_INSTANCE.idFromName(c.req.param("id"));
  const stub = c.env.BOT_INSTANCE.get(id);
  const url = new URL(c.req.url);
  url.pathname = `/api/bot/${c.req.param("id")}/logs`;
  return stub.fetch(new Request(url.toString()));
});

// === Room WebSocket ===
app.get("/api/room/:id/*", async (c) => {
  const id = c.env.GAME_ROOM.idFromName(c.req.param("id"));
  const stub = c.env.GAME_ROOM.get(id);
  return stub.fetch(c.req.raw);
});

export default app;
