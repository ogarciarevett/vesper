/**
 * Daemon-side pairing coordinator for scan-to-connect (QR/link onboarding).
 *
 * The daemon owns a single inbound long-poll per channel; pairing must observe that
 * stream WITHOUT opening a second consumer. {@link PairingCoordinator.tap} wraps the
 * chat sink so every inbound message ALSO feeds active pairing sessions, and
 * {@link PairingCoordinator.startPairing} dispatches to a channel handler's optional
 * `Pairable` capability with a `subscribeInbound` seam backed by that multiplex.
 *
 * - A channel already running in the daemon registry is reused (its live receive loop
 *   feeds the tap). A configured-but-not-running channel gets a TRANSIENT receive loop
 *   for the pairing window only, stopped when the session ends.
 * - On `linked`, the captured chat id is persisted as the channel's non-secret
 *   `params.defaultChatId` and the channel is enabled in config (a restart activates a
 *   not-yet-running channel — the same "restart to apply" contract as `connections set`).
 * - The token never transits this path; only nonces/links/QRs and the resulting chat id.
 */

import {
  CHANNEL_GRANTS,
  type ChannelHandler,
  type ChannelId,
  type ChannelRegistry,
  type ChatSink,
  type ConnectionEventKind,
  channelById,
  channelPluginById,
  type FetchFn,
  type InboundMessage,
  isPairable,
  type PairingSession,
  type PairingUpdate,
  recordConnectionEvent,
  type Stoppable,
  type Store,
  type Vault,
} from "@vesper/core";
import type { ConnectionConfig, VesperConfig } from "./config.ts";

type InboundListener = (message: InboundMessage) => void;

/** Dependencies for the {@link PairingCoordinator}. */
export interface PairingCoordinatorDeps {
  /** The daemon's live channel registry (reused when a channel is already running). */
  readonly registry: ChannelRegistry;
  readonly vault: Vault;
  readonly load: () => Promise<VesperConfig>;
  readonly save: (config: VesperConfig) => Promise<void>;
  /** Audit sink (the daemon store); omitted in unit tests. */
  readonly store?: Store;
  /** Injected fetch so tests reach no network; omit to use the handler's real fetch. */
  readonly fetchFn?: FetchFn;
}

/** A PairingSession that emits a single error then ends (for fail-fast preconditions). */
function errorSession(reason: string): PairingSession {
  return {
    updates: async function* () {
      yield { status: "error", reason };
    },
    stop() {},
  };
}

/** Immutably set one channel's wiring in the config (mirrors `connections.ts`). */
function withConnection(config: VesperConfig, id: string, conn: ConnectionConfig): VesperConfig {
  return { ...config, connections: { ...(config.connections ?? {}), [id]: conn } };
}

export class PairingCoordinator {
  readonly #deps: PairingCoordinatorDeps;
  readonly #listeners = new Set<InboundListener>();

  constructor(deps: PairingCoordinatorDeps) {
    this.#deps = deps;
  }

  /** Wrap the chat sink so inbound ALSO feeds active pairing sessions (single long-poll). */
  tap(realSink: ChatSink): ChatSink {
    return async (message) => {
      this.#notify(message);
      await realSink(message);
    };
  }

  #notify(message: InboundMessage): void {
    for (const listener of this.#listeners) listener(message);
  }

  #subscribe(on: InboundListener): Stoppable {
    this.#listeners.add(on);
    return {
      stop: () => {
        this.#listeners.delete(on);
      },
    };
  }

  /** Begin a pairing attempt for one channel; returns a streamed session. */
  async startPairing(id: string): Promise<PairingSession> {
    const descriptor = channelById(id);
    if (descriptor === undefined) return errorSession(`unknown channel "${id}"`);

    const config = await this.#deps.load();
    const conn = config.connections?.[id];
    const vaultKey = conn?.vaultKey ?? descriptor.vaultKeys[0];
    if (vaultKey === undefined) return errorSession(`channel "${id}" declares no vault key`);

    const plugin = channelPluginById(id);
    const running = this.#deps.registry.byId(id as ChannelId);
    if (plugin === undefined && running === undefined) {
      return errorSession(`channel "${id}" has no handler yet`);
    }
    // SELF-DRIVING channels (e.g. WhatsApp-Web) establish auth via the scan itself and drive
    // their own socket, so they skip the authenticate precondition + the inbound multiplex.
    // CHAT-LINK channels (Telegram/Discord) watch the daemon's single inbound stream for the
    // nonce, reusing the running receiver or a transient one.
    const needsInbound = plugin?.pairingNeedsInbound !== false;
    const buildOpts = {
      granted: CHANNEL_GRANTS,
      vaultKey,
      allowedHosts: conn?.allowedHosts ?? descriptor.allowedHosts,
      ...(conn?.params !== undefined ? { params: conn.params } : {}),
      ...(this.#deps.fetchFn !== undefined ? { fetchFn: this.#deps.fetchFn } : {}),
    };

    let handler: ChannelHandler;
    let transient: Stoppable | undefined;
    if (needsInbound && running !== undefined) {
      handler = running;
    } else {
      if (plugin === undefined) return errorSession(`channel "${id}" has no handler yet`);
      const built = plugin.build(buildOpts);
      if (needsInbound) {
        try {
          await built.authenticate(this.#deps.vault);
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          return errorSession(`cannot authenticate "${id}": ${reason}`);
        }
        transient = built.receive(async (message) => {
          this.#notify(message);
        });
      }
      handler = built;
    }

    if (!isPairable(handler)) {
      transient?.stop();
      return errorSession(`channel "${id}" does not support QR pairing`);
    }

    this.#record("connection_pairing_started", { channel: id, vaultKey });

    const inner = handler.startPairing({
      vault: this.#deps.vault,
      ...(needsInbound
        ? { subscribeInbound: (on: (m: InboundMessage) => void) => this.#subscribe(on) }
        : {}),
    });

    const onUpdate = (update: PairingUpdate): Promise<void> => this.#onUpdate(id, vaultKey, update);
    return {
      updates: async function* () {
        try {
          for await (const update of inner.updates()) {
            await onUpdate(update);
            yield update;
          }
        } finally {
          transient?.stop();
        }
      },
      stop: () => {
        inner.stop();
        transient?.stop();
      },
    };
  }

  async #onUpdate(id: string, vaultKey: string, update: PairingUpdate): Promise<void> {
    if (update.status === "linked") {
      // Enable the channel on link. Chat-link channels carry the captured chat id;
      // self-driving channels (WhatsApp-Web) link the account with no chat id here.
      await this.#persistLinked(id, vaultKey, update.chatId);
      this.#record("connection_paired", {
        channel: id,
        vaultKey,
        ...(update.chatId !== undefined ? { chatId: update.chatId } : {}),
      });
    } else if (update.status === "error" || update.status === "expired") {
      this.#record("connection_pairing_failed", { channel: id, outcome: update.status });
    }
  }

  /** Enable the channel on link, recording the captured chat id (if any) as the default target. */
  async #persistLinked(id: string, vaultKey: string, chatId?: string): Promise<void> {
    const config = await this.#deps.load();
    const descriptor = channelById(id);
    const existing = config.connections?.[id];
    const params = {
      ...existing?.params,
      ...(chatId !== undefined ? { defaultChatId: chatId } : {}),
    };
    const conn: ConnectionConfig = {
      enabled: true,
      vaultKey,
      allowedHosts: existing?.allowedHosts ?? descriptor?.allowedHosts ?? [],
      ...(Object.keys(params).length > 0 ? { params } : {}),
    };
    await this.#deps.save(withConnection(config, id, conn));
  }

  #record(kind: ConnectionEventKind, payload: Record<string, unknown>): void {
    if (this.#deps.store !== undefined) recordConnectionEvent(this.#deps.store, kind, payload);
  }
}
