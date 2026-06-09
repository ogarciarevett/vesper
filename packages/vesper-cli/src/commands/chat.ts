/**
 * `vesper chat` — talk to Vesper from the terminal (specs/orchestrator-home.md,
 * slice E). Drives EXACTLY the daemon endpoints the UI uses (`POST /api/chat` +
 * the `/api/live` WebSocket), so UI/CLI parity is structural: the reply streams
 * as the same `chat:delta` frames the chat home renders.
 */

import type { Command, CommandGroup } from "../dispatch.ts";
import { uiPort } from "../paths.ts";
import { cyan, dim, errorLine, line } from "../ui.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function strFlag(value: string | boolean | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** Open the live socket and subscribe to the session's chat topic. */
function openLive(
  port: number,
  sessionId: string,
  onDelta: (text: string) => void,
): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/live`);
    ws.onopen = () => {
      ws.send(JSON.stringify({ type: "subscribe", sessionId }));
      resolve(ws);
    };
    ws.onerror = () => reject(new Error("could not open the live socket"));
    ws.onmessage = (event) => {
      try {
        const frame: unknown = JSON.parse(String(event.data));
        if (
          typeof frame === "object" &&
          frame !== null &&
          (frame as { type?: unknown }).type === "chat:delta" &&
          typeof (frame as { text?: unknown }).text === "string"
        ) {
          onDelta((frame as { text: string }).text);
        }
      } catch {
        // non-JSON frame — ignore.
      }
    };
  });
}

const sendCommand: Command = {
  name: "send",
  summary: "Send one message to Vesper and stream the reply.",
  usage: 'vesper chat send "<message>" [--session <id>]',
  async run({ positionals, flags }) {
    const message = positionals.join(" ").trim();
    if (message.length === 0) {
      errorLine('usage: vesper chat send "<message>" [--session <id>]');
      return 1;
    }
    const sessionFlag = strFlag(flags.session);
    if (sessionFlag !== undefined && !UUID_RE.test(sessionFlag)) {
      errorLine("--session must be a UUID (printed by a previous `vesper chat`)");
      return 1;
    }
    const port = uiPort();
    const base = `http://127.0.0.1:${port}`;

    // Daemon probe first, so the failure mode is a clear instruction.
    try {
      await fetch(`${base}/api/status`);
    } catch {
      errorLine("the Vesper daemon is not running — start it with `vesper daemon start`");
      return 1;
    }

    // Subscribe BEFORE sending (client-supplied session id), so the first
    // reply's stream is not missed — the same order the UI uses.
    const sessionId = sessionFlag ?? crypto.randomUUID();
    let streamed = false;
    let ws: WebSocket | null = null;
    try {
      ws = await openLive(port, sessionId, (text) => {
        streamed = true;
        process.stdout.write(text);
      });
    } catch {
      // Streaming is a nicety; the POST below still returns the full reply.
    }

    try {
      const res = await fetch(`${base}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message, sessionId }),
      });
      const body = (await res.json()) as { reply?: string; error?: string };
      if (!res.ok) {
        errorLine(body.error ?? `chat failed (HTTP ${res.status})`);
        return 1;
      }
      if (streamed) {
        process.stdout.write("\n");
      } else {
        line(body.reply ?? "(no response)");
      }
      line(dim(`session ${sessionId} — continue: vesper chat send "..." --session ${sessionId}`));
      return 0;
    } finally {
      ws?.close();
    }
  },
};

/** `vesper chat ...` — the terminal chat surface (same endpoints as the UI). */
export const chatGroup: CommandGroup = {
  name: "chat",
  summary: "Talk to Vesper from the terminal (streams via the daemon, like the UI).",
  subcommands: [sendCommand],
};
