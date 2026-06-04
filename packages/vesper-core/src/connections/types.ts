/**
 * Public types for the Connections layer — pluggable messaging-channel handlers
 * modeled exactly on the shipped `UiModule` + `ModuleRegistry` seam.
 *
 * A handler is PURE TRANSPORT: it authenticates, sends an outbound intent, and
 * receives inbound messages. It NEVER reasons — the chatbot/pipeline is the brain
 * (Hard rule 12). Outbound is the only network egress and is `NETWORK_FETCH`-gated
 * through the descriptor's host allowlist (see `fetch.ts`).
 */

import type { Vault } from "../vault/index.ts";

/** The messaging channels Vesper knows about. Catalog-only; no arbitrary channels. */
export type ChannelId = "telegram" | "discord" | "whatsapp" | "signal";

/** Whether a channel is BUILT in v1 or declared-but-deferred (catalog + tutorial only). */
export type ChannelStatus = "ready" | "deferred";

/** The transport a channel handler uses to reach its service. */
export type ChannelTransport = "long-poll" | "webhook" | "bot-api" | "local-cli";

/** An outbound message the chatbot asks a handler to deliver. */
export interface OutboundIntent {
  readonly kind: "reply" | "notify";
  /** Channel-native conversation id (e.g. a Telegram chat id). */
  readonly chatId: string;
  readonly text: string;
}

/** An inbound message a handler received and hands to the {@link ChatSink}. */
export interface InboundMessage {
  readonly channel: ChannelId;
  /** Channel-native conversation id the reply is routed back to. */
  readonly chatId: string;
  /** Channel-native sender identity (id/username); used for audit, never as auth. */
  readonly from: string;
  readonly text: string;
  /** Unix timestamp in milliseconds the message arrived. */
  readonly ts: number;
}

/**
 * A {@link CHANNEL_CATALOG} entry — the single source of truth for a channel.
 * Mirrors the curated-CATALOG-constant pattern: user input selects an id (a KEY),
 * never an arbitrary host or URL.
 */
export interface ChannelDescriptor {
  readonly id: ChannelId;
  readonly displayName: string;
  readonly transport: ChannelTransport;
  /** Host-allowlist seam for `NETWORK_FETCH` (e.g. `["api.telegram.org"]`). Non-empty for ready channels. */
  readonly allowedHosts: readonly string[];
  /** Vault KEY names this channel needs (NEVER the values). */
  readonly vaultKeys: readonly string[];
  /** The per-channel setup-tutorial anchor (#12). */
  readonly docsUrl: string;
  readonly status: ChannelStatus;
}

/** Forwards an inbound message into the chatbot. The v1 impl POSTs to `/api/chat`. */
export type ChatSink = (message: InboundMessage) => Promise<void>;

/**
 * A stop handle for a long-running `receive` loop. Idempotent: calling `stop`
 * more than once is a no-op. Mirrors the Bun-idiomatic "Stoppable" shape used by
 * the UI server handle.
 */
export interface Stoppable {
  stop(): void;
}

/**
 * A pluggable channel handler — the {@link import("../../../vesper-ui/src/modules/types.ts").UiModule}
 * analogue. Telegram is the only handler BUILT in v1; Discord shares this contract.
 */
export interface ChannelHandler {
  readonly descriptor: ChannelDescriptor;
  /** Load the credential from the vault (READ_VAULT) and verify it (e.g. getMe). */
  authenticate(vault: Vault): Promise<void>;
  /** Deliver an outbound intent. NETWORK_FETCH, host-allowlisted to the descriptor. */
  send(intent: OutboundIntent): Promise<void>;
  /** Start the inbound loop feeding `sink`; returns a stop handle. */
  receive(sink: ChatSink): Stoppable;
}
