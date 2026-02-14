import { useEffect, useRef, useState, useCallback } from "react";
import type {
  AgentRealtimeState,
  ServerMessage,
  ClientMessage,
} from "@repo/types";

const API_URL = import.meta.env.VITE_API_URL || "http://localhost:8787";
const GATEWAY_PASSWORD = import.meta.env.VITE_GATEWAY_PASSWORD || "";

/** Room-level aggregated state from ROOM_STATE messages */
export interface RoomState {
  roomId: string;
  botCount: number;
  activeBotCount: number;
  totalPnl: number;
  totalPnlToday: number;
  totalExposure: number;
  riskStatus: "NORMAL" | "WARNING" | "BREACHED";
}

/** Trade event from TRADE_EVENT messages */
export interface TradeEvent {
  agentId: string;
  timestamp: string;
  event: string;
  data: Record<string, unknown>;
}

const PING_INTERVAL_MS = 30_000;
const RECONNECT_DELAY_MS = 3_000;

function buildWsUrl(roomId: string): string {
  const base = new URL(API_URL);
  base.protocol = base.protocol === "https:" ? "wss:" : "ws:";
  base.pathname = `/api/room/${roomId}/ws`;
  if (GATEWAY_PASSWORD) {
    base.searchParams.set("gateway_password", GATEWAY_PASSWORD);
  }
  return base.toString();
}

export function useTradingSocket(roomId: string) {
  const [isConnected, setIsConnected] = useState(false);
  const [connectionState, setConnectionState] = useState<
    "connecting" | "connected" | "reconnecting" | "error"
  >("connecting");
  const [reconnectAttempts, setReconnectAttempts] = useState(0);
  const [botStates, setBotStates] = useState<Map<string, AgentRealtimeState>>(
    () => new Map(),
  );
  const [roomState, setRoomState] = useState<RoomState | null>(null);
  const [tradeEvents, setTradeEvents] = useState<TradeEvent[]>([]);
  const [lastError, setLastError] = useState<string | null>(null);

  const socketRef = useRef<WebSocket | null>(null);
  const pingTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);

  const handleMessage = useCallback((data: string) => {
    let msg: ServerMessage & { type: string; [key: string]: unknown };
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }

    switch (msg.type) {
      case "FULL_STATE": {
        const fullState = msg as unknown as {
          type: "FULL_STATE";
          agentId: string;
          state: AgentRealtimeState;
        };
        setBotStates((prev) => {
          const next = new Map(prev);
          next.set(fullState.agentId, fullState.state);
          return next;
        });
        break;
      }

      case "STATE_DELTA": {
        const delta = msg as unknown as {
          type: "STATE_DELTA";
          agentId: string;
          changes: Partial<AgentRealtimeState>;
        };
        setBotStates((prev) => {
          const existing = prev.get(delta.agentId);
          if (!existing) return prev;
          const next = new Map(prev);
          next.set(delta.agentId, { ...existing, ...delta.changes });
          return next;
        });
        break;
      }

      case "ROOM_STATE": {
        const room = msg as unknown as { type: "ROOM_STATE" } & RoomState;
        setRoomState({
          roomId: room.roomId,
          botCount: room.botCount,
          activeBotCount: room.activeBotCount,
          totalPnl: room.totalPnl,
          totalPnlToday: room.totalPnlToday,
          totalExposure: room.totalExposure,
          riskStatus: room.riskStatus,
        });
        break;
      }

      case "TRADE_EVENT": {
        const trade = msg as unknown as {
          type: "TRADE_EVENT";
          agentId: string;
          timestamp: string;
          event: string;
          data: Record<string, unknown>;
        };
        setTradeEvents((prev) => {
          const next = [
            {
              agentId: trade.agentId,
              timestamp: trade.timestamp,
              event: trade.event,
              data: trade.data,
            },
            ...prev,
          ];
          if (next.length > 50) next.length = 50;
          return next;
        });
        break;
      }

      case "ERROR": {
        const error = msg as unknown as {
          type: "ERROR";
          code: string;
          message: string;
        };
        setLastError(`[${error.code}] ${error.message}`);
        console.error("TradingRoom WS error:", error.code, error.message);
        break;
      }

      case "PONG": {
        // Heartbeat acknowledged; nothing to do
        break;
      }
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    let ws: WebSocket;

    const connect = () => {
      if (!roomId) {
        setConnectionState("error");
        setLastError("Missing roomId for TradingRoom WebSocket");
        return;
      }

      setConnectionState("connecting");
      const url = buildWsUrl(roomId);
      console.log("[TradingSocket] Connecting to:", url);
      ws = new WebSocket(url);

      ws.onopen = () => {
        if (!mountedRef.current) return;
        console.log("[TradingSocket] Connected");
        setIsConnected(true);
        setConnectionState("connected");
        setReconnectAttempts(0);
        setLastError(null);

        // Start ping interval
        pingTimerRef.current = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            const ping: ClientMessage = { type: "PING" };
            ws.send(JSON.stringify(ping));
          }
        }, PING_INTERVAL_MS);
      };

      ws.onmessage = (event) => {
        if (!mountedRef.current) return;
        handleMessage(event.data as string);
      };

      ws.onclose = () => {
        if (!mountedRef.current) return;
        console.log("[TradingSocket] Disconnected. Reconnecting...");
        setIsConnected(false);
        setConnectionState("reconnecting");
        cleanup();
        setReconnectAttempts((prev) => prev + 1);
        reconnectTimerRef.current = setTimeout(connect, RECONNECT_DELAY_MS);
      };

      ws.onerror = (error) => {
        console.error("[TradingSocket] Error:", error);
        setConnectionState("error");
        setLastError("WebSocket transport error");
        ws.close();
      };

      socketRef.current = ws;
    };

    const cleanup = () => {
      if (pingTimerRef.current) {
        clearInterval(pingTimerRef.current);
        pingTimerRef.current = null;
      }
    };

    connect();

    return () => {
      mountedRef.current = false;
      cleanup();
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      if (ws) ws.close();
    };
  }, [roomId, handleMessage]);

  const subscribe = useCallback((agentId: string) => {
    const ws = socketRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      const msg: ClientMessage = { type: "SUBSCRIBE", agentId };
      ws.send(JSON.stringify(msg));
    }
  }, []);

  const unsubscribe = useCallback((agentId: string) => {
    const ws = socketRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      const msg: ClientMessage = { type: "UNSUBSCRIBE", agentId };
      ws.send(JSON.stringify(msg));
    }
  }, []);

  return {
    isConnected,
    connectionState,
    reconnectAttempts,
    botStates,
    roomState,
    tradeEvents,
    lastError,
    subscribe,
    unsubscribe,
  };
}
