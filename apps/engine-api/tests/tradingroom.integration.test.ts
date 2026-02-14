import { describe, expect, test } from "bun:test";
import type { ServerMessage } from "@repo/types";

const baseUrl = process.env.OPENCLAW_INTEGRATION_BASE_URL;
const gatewayPassword = process.env.OPENCLAW_GATEWAY_PASSWORD;

async function fetchJson<T>(
  path: string,
  init: RequestInit = {},
): Promise<{ status: number; data: T }> {
  if (!baseUrl) {
    throw new Error("OPENCLAW_INTEGRATION_BASE_URL is required");
  }

  const headers = new Headers(init.headers);
  if (gatewayPassword) {
    headers.set("x-openclaw-gateway-password", gatewayPassword);
  }
  if (init.body && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }

  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers,
  });
  return {
    status: response.status,
    data: (await response.json()) as T,
  };
}

async function waitForMessage(
  ws: WebSocket,
  predicate: (msg: ServerMessage & { type: string }) => boolean,
  timeoutMs = 10000,
): Promise<ServerMessage & { type: string }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.removeEventListener("message", onMessage as EventListener);
      reject(new Error(`Timed out waiting for message after ${timeoutMs}ms`));
    }, timeoutMs);

    const onMessage = (event: MessageEvent) => {
      try {
        const parsed = JSON.parse(String(event.data)) as ServerMessage & {
          type: string;
        };
        if (!predicate(parsed)) return;
        clearTimeout(timer);
        ws.removeEventListener("message", onMessage as EventListener);
        resolve(parsed);
      } catch {
        // ignore parse errors from non-JSON frames
      }
    };

    ws.addEventListener("message", onMessage as EventListener);
  });
}

if (!baseUrl || !gatewayPassword) {
  test("integration env not configured", () => {
    expect(true).toBeTrue();
  });
} else {
  describe("TradingRoom integration", () => {
    test("ws protocol and emergency stop response work end-to-end", async () => {
      const roomId = "main";
      const botName = `integration-bot-${Date.now()}`;

      const createRoom = await fetchJson<{ ok: boolean }>(`/api/room`, {
        method: "POST",
        body: JSON.stringify({ name: roomId }),
      });
      expect(createRoom.status).toBe(200);
      expect(createRoom.data.ok).toBeTrue();

      const createBot = await fetchJson<{ ok: boolean; botId: string }>(
        `/api/room/${roomId}/bot`,
        {
          method: "POST",
          body: JSON.stringify({
            name: botName,
            config: { trading: { pairs: ["ETH"] } },
          }),
        },
      );
      expect(createBot.status).toBe(200);
      expect(createBot.data.ok).toBeTrue();

      const startBot = await fetchJson<{ ok: boolean }>(
        `/api/bot/${createBot.data.botId}/start`,
        {
          method: "POST",
          body: JSON.stringify({ roomId, pair: "ETH" }),
        },
      );
      expect(startBot.status).toBe(200);
      expect(startBot.data.ok).toBeTrue();

      const wsUrl = new URL(baseUrl);
      wsUrl.protocol = wsUrl.protocol === "https:" ? "wss:" : "ws:";
      wsUrl.pathname = `/api/room/${roomId}/ws`;
      wsUrl.searchParams.set("gateway_password", gatewayPassword);

      const ws = new WebSocket(wsUrl.toString());
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("WS open timeout")), 10000);
        ws.onopen = () => {
          clearTimeout(timer);
          resolve();
        };
        ws.onerror = () => {
          clearTimeout(timer);
          reject(new Error("WS open error"));
        };
      });

      const fullState = await waitForMessage(ws, (msg) => msg.type === "FULL_STATE");
      expect(fullState.type).toBe("FULL_STATE");

      ws.send(JSON.stringify({ type: "PING" }));
      const pong = await waitForMessage(ws, (msg) => msg.type === "PONG");
      expect(pong.type).toBe("PONG");

      const emergency = await fetchJson<{
        ok: boolean;
        results: Array<{ agentId: string }>;
      }>(`/api/room/${roomId}/emergency-stop`, { method: "POST" });
      expect(emergency.status).toBe(200);
      expect(Array.isArray(emergency.data.results)).toBeTrue();
      expect(
        emergency.data.results.some((r) => r.agentId === createBot.data.botId),
      ).toBeTrue();

      ws.close();
    }, 60000);
  });
}
