import { useEffect, useRef, useState } from "react";

const WS_URL = import.meta.env.VITE_API_URL || "ws://localhost:8787";

export function useGameSocket(roomId: string = "main") {
  const [isConnected, setIsConnected] = useState(false);
  const [lastMessage, setLastMessage] = useState<string | null>(null);
  const socketRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    let ws: WebSocket;
    let reconnectTimer: any;
    const host = WS_URL.replace(/^http/, "ws");
    const url = `${host}/api/room/${roomId}/ws`;

    const connect = () => {
      console.log("Connecting to:", url);
      ws = new WebSocket(url);

      ws.onopen = () => {
        console.log("WebSocket Connected");
        setIsConnected(true);
      };

      ws.onmessage = (event) => {
        // console.log("WS Message:", event.data);
        setLastMessage(event.data);
      };

      ws.onclose = () => {
        console.log("WebSocket Disconnected. Reconnecting in 3s...");
        setIsConnected(false);
        // Auto-reconnect
        reconnectTimer = setTimeout(connect, 3000);
      };

      ws.onerror = (error) => {
        console.error("WebSocket Error:", error);
        ws.close(); // Trigger onclose to reconnect
      };

      socketRef.current = ws;
    };

    connect();

    return () => {
      if (ws) ws.close();
      if (reconnectTimer) clearTimeout(reconnectTimer);
    };
  }, [roomId]);

  const sendMessage = (msg: Record<string, any>) => {
    if (socketRef.current && socketRef.current.readyState === WebSocket.OPEN) {
      socketRef.current.send(JSON.stringify(msg));
    }
  };

  return { isConnected, lastMessage, sendMessage };
}
