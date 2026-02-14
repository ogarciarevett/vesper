const API_URL = import.meta.env.VITE_API_URL || "http://localhost:8787";

export const api = {
  async getStatus(): Promise<{ status: string; timestamp: number; version: string }> {
    const res = await fetch(`${API_URL}/api/status`);
    return res.json();
  },

  async getBotStatus(botId: string): Promise<any> {
    const res = await fetch(`${API_URL}/api/bot/${botId}/status`);
    return res.json();
  },

  async getBotLogs(botId: string): Promise<{ logs: any[] }> {
    const res = await fetch(`${API_URL}/api/bot/${botId}/logs`);
    return res.json();
  },

  async startBot(botId: string): Promise<any> {
    const res = await fetch(`${API_URL}/api/bot/${botId}/start`, { method: "POST" });
    return res.json();
  },

  async stopBot(botId: string): Promise<any> {
    const res = await fetch(`${API_URL}/api/bot/${botId}/stop`, { method: "POST" });
    return res.json();
  },
};
