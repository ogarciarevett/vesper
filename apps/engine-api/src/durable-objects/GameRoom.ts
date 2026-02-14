import { DurableObject } from "cloudflare:workers";

export class GameRoom extends DurableObject {
  sessions: Map<WebSocket, any>;

  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
    this.sessions = new Map();
  }

  async fetch(request: Request): Promise<Response> {
    const upgradeHeader = request.headers.get("Upgrade");
    if (!upgradeHeader || upgradeHeader !== "websocket") {
      return new Response("Expected Upgrade: websocket", { status: 426 });
    }

    const webSocketPair = new WebSocketPair();
    const [client, server] = Object.values(webSocketPair);

    this.ctx.acceptWebSocket(server);
    this.sessions.set(server, { id: crypto.randomUUID() });

    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    // Broadcast to all other sessions
    // In a real app, we would parse the message and update state
    for (const [session, data] of this.sessions) {
      if (session !== ws) {
        try {
            session.send(message);
        } catch (err) {
            // Handle error
        }
      }
    }
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean) {
    this.sessions.delete(ws);
  }
}
