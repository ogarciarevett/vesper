import { useEffect, useState, useCallback } from "react";
import { api } from "../lib/api";

export interface BotStatus {
  id: string;
  isRunning: boolean;
  startedAt: number | null;
  tickCount: number;
  lastTick: number | null;
  lastDecision: any | null;
  errors: number;
  strategy: string;
  uptime: number;
}

export function useBotStatus(botId: string, pollInterval = 3000) {
  const [status, setStatus] = useState<BotStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const data = await api.getBotStatus(botId);
      setStatus(data);
      setError(null);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, [botId]);

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, pollInterval);
    return () => clearInterval(interval);
  }, [refresh, pollInterval]);

  const start = useCallback(async () => {
    await api.startBot(botId);
    await refresh();
  }, [botId, refresh]);

  const stop = useCallback(async () => {
    await api.stopBot(botId);
    await refresh();
  }, [botId, refresh]);

  return { status, loading, error, refresh, start, stop };
}
