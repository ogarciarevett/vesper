/**
 * The WhatsApp-Web (personal-account) channel handler. Unlike the bot-API channels,
 * this links a real WhatsApp account by QR scan over the WhatsApp-Web protocol
 * (Baileys). It is the opt-in `@vesper/channel-whatsapp-web` package's whole reason
 * to exist — the Baileys dependency lives ONLY here, never in core.
 *
 * It is pure transport (Hard rule 12): pairing drives a Baileys socket to obtain a
 * linked session (persisted to the vault via {@link makeVaultAuthState}); `receive`
 * re-opens that session and feeds inbound text into the {@link ChatSink}; `send`
 * posts a text message on the live socket. Egress is the WhatsApp-Web WebSocket that
 * Baileys owns — there is no `allowlistedFetch` seam for this transport (see the
 * catalog descriptor note).
 *
 * The Baileys socket is reached ONLY through the small {@link WASocketFactory} seam,
 * so the whole test suite injects a fake and never opens a real WebSocket.
 */

import {
  type Capability,
  type ChannelDescriptor,
  type ChannelHandler,
  type ChatSink,
  ConnectionError,
  channelById,
  type InboundMessage,
  type OutboundIntent,
  type Pairable,
  type PairingDeps,
  type PairingSession,
  type PairingUpdate,
  type Stoppable,
  type Vault,
} from "@vesper/core";
import makeWASocket, { type AuthenticationState, DisconnectReason } from "baileys";
import { makeVaultAuthState } from "./vault-auth-state.ts";

/** How long a rendered QR is advertised as valid before WhatsApp rotates it. */
const QR_ROTATE_MS = 60_000;

/** The WhatsApp-Web catalog descriptor (non-null — it is a built-in catalog id). */
const WHATSAPP_WEB_DESCRIPTOR = channelById("whatsapp-web");

/**
 * The minimal slice of a Baileys socket this handler depends on. Modeling only what
 * we use keeps the injection seam tiny and lets the suite supply a fake without
 * reconstructing the full `WASocket` type.
 */
export interface WASocket {
  readonly ev: {
    on(event: string, listener: (payload: unknown) => void): void;
    off?(event: string, listener: (payload: unknown) => void): void;
  };
  sendMessage(jid: string, content: { text: string }): Promise<unknown>;
  /** Close the underlying WebSocket. Baileys exposes `end(error?)`. */
  end(error?: Error): void;
}

/** The config we hand the factory — a structural subset of Baileys' `UserFacingSocketConfig`. */
export interface WASocketConfig {
  readonly auth: AuthenticationState;
  readonly printQRInTerminal: boolean;
}

/** Builds a Baileys socket from a config. Injected so tests never open a real socket. */
export type WASocketFactory = (config: WASocketConfig) => WASocket;

/** Options for {@link WhatsAppWebHandler}. */
export interface WhatsAppWebHandlerOptions {
  /** Capabilities the handler was granted. */
  readonly granted: readonly Capability[];
  /** Vault KEY the linked session blob is stored under. Defaults to `whatsapp_web_session`. */
  readonly vaultKey?: string;
  /** Builds a Baileys socket; defaults to the real `makeWASocket`. */
  readonly socketFactory?: WASocketFactory;
}

/** A Baileys `connection.update` payload (the subset we narrow against). */
interface ConnectionUpdate {
  readonly connection?: "connecting" | "open" | "close";
  readonly lastDisconnect?: { readonly error?: unknown };
  readonly qr?: string;
}

/** A Baileys `messages.upsert` payload (the subset we narrow against). */
interface MessagesUpsert {
  readonly messages: readonly WAMessageLike[];
  readonly type: string;
}

/** The slice of a Baileys `WAMessage` this handler reads. */
interface WAMessageLike {
  readonly key?: {
    readonly remoteJid?: string | null;
    readonly fromMe?: boolean | null;
    readonly participant?: string | null;
  };
  readonly message?: {
    readonly conversation?: string | null;
    readonly extendedTextMessage?: { readonly text?: string | null } | null;
  } | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** The real socket factory: thin wrapper over `makeWASocket`. */
const defaultSocketFactory: WASocketFactory = (config) =>
  makeWASocket(config) as unknown as WASocket;

export class WhatsAppWebHandler implements ChannelHandler, Pairable {
  readonly descriptor: ChannelDescriptor;
  /** Capabilities this handler was granted (recorded for audit; this transport has no fetch seam). */
  readonly granted: readonly Capability[];
  readonly #vaultKey: string;
  readonly #socketFactory: WASocketFactory;
  #authState: AuthenticationState | null = null;
  #liveSocket: WASocket | null = null;

  constructor(options: WhatsAppWebHandlerOptions) {
    if (WHATSAPP_WEB_DESCRIPTOR === undefined) {
      throw new Error("whatsapp-web descriptor missing from catalog");
    }
    this.descriptor = WHATSAPP_WEB_DESCRIPTOR;
    this.granted = options.granted;
    this.#vaultKey = options.vaultKey ?? "whatsapp_web_session";
    this.#socketFactory = options.socketFactory ?? defaultSocketFactory;
  }

  /** Load the linked session from the vault; an unpaired account is skipped by the daemon. */
  async authenticate(vault: Vault): Promise<void> {
    let blob: string;
    try {
      blob = await vault.get(this.#vaultKey);
    } catch {
      throw new ConnectionError(
        "not_authenticated",
        "whatsapp-web has no linked session — pair it first",
      );
    }
    if (blob.trim() === "") {
      throw new ConnectionError("not_authenticated", "whatsapp-web session blob is empty");
    }
    const { state } = await makeVaultAuthState(vault, this.#vaultKey);
    this.#authState = state;
  }

  /**
   * Self-driving QR pairing (ignores {@link PairingDeps.subscribeInbound}). Opens a
   * Baileys socket from a fresh vault-backed auth state and bridges its
   * `connection.update`/`creds.update` events into an async queue the generator
   * drains in order — `awaiting` REPEATS as WhatsApp rotates the QR, so a single
   * promise would drop rotations.
   */
  startPairing(deps: PairingDeps): PairingSession {
    const queue = new UpdateQueue();
    let socket: WASocket | null = null;
    let stopped = false;
    let saveCreds: (() => Promise<void>) | null = null;

    const closeSocket = (): void => {
      if (socket === null) return;
      try {
        socket.end();
      } catch {
        // end() is best-effort; a double-close must not throw.
      }
      socket = null;
    };

    const onConnection = (payload: unknown): void => {
      const update = asConnectionUpdate(payload);
      if (update.qr !== undefined) {
        queue.push({
          status: "awaiting",
          prompt: {
            kind: "code",
            data: update.qr,
            humanHint:
              "Open WhatsApp > Settings > Linked Devices > Link a Device, and scan this code.",
            expiresAt: Date.now() + QR_ROTATE_MS,
          },
        });
        return;
      }
      if (update.connection === "open") {
        void (async () => {
          if (saveCreds !== null) await saveCreds();
          queue.push({ status: "linked" });
          queue.close();
          closeSocket();
        })();
        return;
      }
      if (update.connection === "close") {
        queue.push({ status: "error", reason: describeDisconnect(update.lastDisconnect?.error) });
        queue.close();
        closeSocket();
      }
    };

    const start = async (): Promise<void> => {
      const authState = await makeVaultAuthState(deps.vault, this.#vaultKey);
      saveCreds = authState.saveCreds;
      if (stopped) return;
      socket = this.#socketFactory({ auth: authState.state, printQRInTerminal: false });
      socket.ev.on("connection.update", onConnection);
      socket.ev.on("creds.update", () => {
        void authState.saveCreds();
      });
    };

    void start().catch((error: unknown) => {
      queue.push({ status: "error", reason: describeError(error) });
      queue.close();
    });

    return {
      updates: () => queue.drain(),
      stop: () => {
        if (stopped) return;
        stopped = true;
        if (queue.pushIfOpen({ status: "expired" })) queue.close();
        closeSocket();
      },
    };
  }

  /** Send a text message on the live socket opened by {@link receive}. */
  async send(intent: OutboundIntent): Promise<void> {
    if (this.#liveSocket === null) {
      throw new ConnectionError("send_failed", "whatsapp-web is not connected");
    }
    await this.#liveSocket.sendMessage(intent.chatId, { text: intent.text });
  }

  /**
   * Open a socket from the loaded auth state and feed each non-`fromMe` text message
   * into `sink`. The socket reference is kept so {@link send} can reply on it.
   */
  receive(sink: ChatSink): Stoppable {
    if (this.#authState === null) {
      throw new ConnectionError(
        "not_authenticated",
        "whatsapp-web must authenticate before receive",
      );
    }
    const socket = this.#socketFactory({ auth: this.#authState, printQRInTerminal: false });
    this.#liveSocket = socket;

    socket.ev.on("messages.upsert", (payload: unknown) => {
      const upsert = asMessagesUpsert(payload);
      if (upsert === null) return;
      for (const raw of upsert.messages) {
        const inbound = toInbound(raw);
        if (inbound === null) continue;
        void Promise.resolve(sink(inbound)).catch(() => {
          // A sink failure (chatbot down) must not stop ingress.
        });
      }
    });

    return {
      stop: () => {
        if (this.#liveSocket === socket) this.#liveSocket = null;
        try {
          socket.end();
        } catch {
          // Idempotent close.
        }
      },
    };
  }
}

/**
 * A tiny async queue: producers `push` {@link PairingUpdate}s, a single consumer
 * `drain()`s them as an async generator. It exists because `awaiting` fires
 * repeatedly (QR rotation) — a queue preserves order and never drops an update
 * arriving before the consumer awaits it.
 */
class UpdateQueue {
  #buffer: PairingUpdate[] = [];
  #closed = false;
  #wake: (() => void) | null = null;

  push(update: PairingUpdate): void {
    if (this.#closed) return;
    this.#buffer.push(update);
    this.#wake?.();
    this.#wake = null;
  }

  /** Push only while open; returns whether the push landed (used by an idempotent stop). */
  pushIfOpen(update: PairingUpdate): boolean {
    if (this.#closed) return false;
    this.push(update);
    return true;
  }

  close(): void {
    this.#closed = true;
    this.#wake?.();
    this.#wake = null;
  }

  async *drain(): AsyncGenerator<PairingUpdate> {
    while (true) {
      while (this.#buffer.length > 0) {
        yield this.#buffer.shift() as PairingUpdate;
      }
      if (this.#closed) return;
      await new Promise<void>((resolve) => {
        this.#wake = resolve;
      });
    }
  }
}

/** Narrow an unknown `connection.update` payload to the fields we read. */
function asConnectionUpdate(payload: unknown): ConnectionUpdate {
  if (!isRecord(payload)) return {};
  const connection =
    payload.connection === "connecting" ||
    payload.connection === "open" ||
    payload.connection === "close"
      ? payload.connection
      : undefined;
  const lastDisconnect = isRecord(payload.lastDisconnect)
    ? { error: payload.lastDisconnect.error }
    : undefined;
  const qr = typeof payload.qr === "string" ? payload.qr : undefined;
  return {
    ...(connection !== undefined ? { connection } : {}),
    ...(lastDisconnect !== undefined ? { lastDisconnect } : {}),
    ...(qr !== undefined ? { qr } : {}),
  };
}

/** Narrow an unknown `messages.upsert` payload, or null if it is not one. */
function asMessagesUpsert(payload: unknown): MessagesUpsert | null {
  if (!isRecord(payload) || !Array.isArray(payload.messages)) return null;
  return {
    messages: payload.messages as readonly WAMessageLike[],
    type: typeof payload.type === "string" ? payload.type : "",
  };
}

/** Build an {@link InboundMessage} from a Baileys message, or null to skip it. */
function toInbound(raw: WAMessageLike): InboundMessage | null {
  const key = raw.key;
  if (key === undefined || key.fromMe === true) return null;
  const remoteJid = key.remoteJid ?? undefined;
  if (remoteJid === undefined || remoteJid === null) return null;
  const text = raw.message?.conversation ?? raw.message?.extendedTextMessage?.text ?? undefined;
  if (text === undefined || text === null || text === "") return null;
  return {
    channel: "whatsapp-web",
    chatId: remoteJid,
    from: key.participant ?? remoteJid,
    text,
    ts: Date.now(),
  };
}

/** Human-readable reason for a `connection: "close"` disconnect. */
function describeDisconnect(error: unknown): string {
  if (isRecord(error)) {
    const status = isRecord(error.output) ? error.output.statusCode : undefined;
    if (status === DisconnectReason.loggedOut) return "whatsapp-web logged out";
  }
  return describeError(error);
}

/** A safe string for any thrown value. */
function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "whatsapp-web connection closed";
}
