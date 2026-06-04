/**
 * Daemon-side Connections wiring: turn the config's channel block into a live
 * {@link ChannelRegistry}, and bridge inbound messages to the chatbot.
 *
 * `buildChannelRegistry` builds + authenticates + registers every channel that is
 * available (a plugin ships), enabled, and has a stored credential — isolating and
 * auditing any that fail to authenticate so one bad token never blocks the others.
 * `makeChannelSink` returns the {@link ChatSink} the registry feeds: each inbound
 * message is a `POST /api/chat` (the chatbot's EXISTING run path — no new brain), and
 * the assistant reply is delivered back over the same channel via `handler.send`.
 */

import {
  CHANNEL_GRANTS,
  ChannelRegistry,
  type ChatSink,
  channelPluginById,
  type FetchFn,
  type InboundMessage,
  recordConnectionEvent,
  type Store,
  type Vault,
} from "@vesper/core";
import type { VesperConfig } from "./config.ts";

/** A built registry plus the ids of channels whose handlers actually started. */
export interface BuiltChannelRegistry {
  readonly registry: ChannelRegistry;
  readonly runningIds: readonly string[];
}

/** Build + authenticate + register every available, enabled, configured channel. */
export async function buildChannelRegistry(opts: {
  readonly connections?: VesperConfig["connections"];
  readonly vault: Vault;
  /** Audit sink (the daemon store); omitted in unit tests. */
  readonly store?: Store;
  /** Injected fetch so tests reach no network; omit to use the handler's real fetch. */
  readonly fetchFn?: FetchFn;
}): Promise<BuiltChannelRegistry> {
  const registry = new ChannelRegistry();
  const runningIds: string[] = [];
  for (const [id, conn] of Object.entries(opts.connections ?? {})) {
    if (!conn.enabled) continue;
    const plugin = channelPluginById(id);
    if (plugin === undefined) continue; // no handler ships for this channel
    const handler = plugin.build({
      granted: CHANNEL_GRANTS,
      vaultKey: conn.vaultKey,
      allowedHosts: conn.allowedHosts,
      ...(conn.params !== undefined ? { params: conn.params } : {}),
      ...(opts.fetchFn !== undefined ? { fetchFn: opts.fetchFn } : {}),
    });
    try {
      await handler.authenticate(opts.vault);
    } catch {
      // A missing/invalid token must not block the other channels; audit + skip.
      if (opts.store !== undefined) {
        recordConnectionEvent(opts.store, "connection_send_failed", {
          channel: id,
          reason: "authenticate",
        });
      }
      continue;
    }
    registry.register(handler);
    runningIds.push(id);
    if (opts.store !== undefined) {
      recordConnectionEvent(opts.store, "connection_connected", {
        channel: id,
        vaultKey: conn.vaultKey,
      });
    }
  }
  return { registry, runningIds };
}

/**
 * Build the {@link ChatSink} that forwards an inbound channel message to the local
 * chatbot (`POST {baseUrl}/api/chat`) and delivers the reply back over the channel.
 * Each `channel:chatId` maps to a persistent Vesper chat session for the daemon's
 * lifetime (an in-memory Map; a restart starts a fresh session).
 */
export function makeChannelSink(opts: {
  readonly baseUrl: string;
  readonly registry: ChannelRegistry;
  readonly fetchFn?: FetchFn;
}): ChatSink {
  const post: FetchFn = opts.fetchFn ?? ((input, init) => fetch(input, init));
  const sessions = new Map<string, string>();
  return async (msg: InboundMessage): Promise<void> => {
    const key = `${msg.channel}:${msg.chatId}`;
    const sessionId = sessions.get(key);
    const res = await post(`${opts.baseUrl}/api/chat`, {
      method: "POST",
      // The local-origin guard requires a local Origin; the daemon talks to itself.
      headers: { "content-type": "application/json", origin: opts.baseUrl },
      body: JSON.stringify(
        sessionId === undefined ? { message: msg.text } : { message: msg.text, sessionId },
      ),
    });
    const body = (await res.json()) as { sessionId?: string; reply?: string };
    if (typeof body.sessionId === "string") sessions.set(key, body.sessionId);
    const handler = opts.registry.byId(msg.channel);
    if (handler !== undefined && typeof body.reply === "string" && body.reply.length > 0) {
      await handler.send({ kind: "reply", chatId: msg.chatId, text: body.reply });
    }
  };
}
