import { useEffect, useState, useCallback } from "react";
import { api } from "../lib/api";

export function useApiStatus(pollInterval = 5000) {
  const [online, setOnline] = useState(false);
  const [lastUpdate, setLastUpdate] = useState<number | null>(null);

  const refresh = useCallback(async () => {
    try {
      const data = await api.getStatus();
      setOnline(data.status === "online");
      setLastUpdate(data.timestamp);
    } catch {
      setOnline(false);
    }
  }, []);

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, pollInterval);
    return () => clearInterval(interval);
  }, [refresh, pollInterval]);

  return { online, lastUpdate, refresh };
}
