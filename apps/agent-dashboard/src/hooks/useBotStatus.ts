import { useEffect, useState, useCallback } from "react";
import type { AgentState, AgentActivity, Position } from "@repo/types";
import { api } from "../lib/api";

export interface BotStatus {
  id: string;
  isRunning: boolean;
  agentState: AgentState;
  activity: AgentActivity;
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
  uptime: number;
}

/** Fallback polling hook for bot status. Reduced interval since WebSocket is primary. */
export interface UseBotStatusOptions {
  pollInterval?: number;
  roomId?: string;
  pair?: string;
}

export function useBotStatus(
  botId: string,
  options: UseBotStatusOptions = {},
) {
  const pollInterval = options.pollInterval ?? 15_000;
  const [status, setStatus] = useState<BotStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const data = await api.getBotStatus(botId, options.roomId);
      setStatus({
        id: data.id,
        isRunning: data.isRunning,
        agentState: (data.agentState ?? "CREATED") as AgentState,
        activity: (data.activity ?? "IDLE") as AgentActivity,
        startedAt: data.startedAt,
        tickCount: data.tickCount,
        lastTick: data.lastTick,
        lastDecision: data.lastDecision,
        currentThought: data.currentThought,
        errors: data.errors,
        consecutiveErrors: data.consecutiveErrors,
        pair: data.pair,
        positions: data.positions ?? [],
        pnlTotal: data.pnlTotal ?? 0,
        pnlToday: data.pnlToday ?? 0,
        tradeCountToday: data.tradeCountToday ?? 0,
        strategy: data.strategy,
        uptime: data.uptime,
      });
      setError(null);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, [botId, options.roomId]);

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, pollInterval);
    return () => clearInterval(interval);
  }, [refresh, pollInterval]);

  const start = useCallback(async () => {
    const startConfig: Record<string, unknown> = {};
    if (options.roomId) startConfig.roomId = options.roomId;
    if (options.pair) startConfig.pair = options.pair;
    await api.startBot(
      botId,
      Object.keys(startConfig).length > 0 ? startConfig : undefined,
      options.roomId,
    );
    await refresh();
  }, [botId, options.pair, options.roomId, refresh]);

  const stop = useCallback(async () => {
    await api.stopBot(botId, options.roomId);
    await refresh();
  }, [botId, options.roomId, refresh]);

  const pause = useCallback(async () => {
    await api.pauseBot(botId, options.roomId);
    await refresh();
  }, [botId, options.roomId, refresh]);

  return { status, loading, error, refresh, start, stop, pause };
}
