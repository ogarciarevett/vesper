/**
 * The Discord channel handler — pure transport over the Bot API + Gateway.
 *
 * Discord has no long-poll: inbound messages arrive over the Gateway WebSocket
 * (HELLO -> IDENTIFY with intents -> heartbeat -> MESSAGE_CREATE), and replies are
 * REST `POST /channels/{id}/messages`. Every HTTP call routes through the injected
 * {@link allowlistedFetch} seam, and the Gateway WebSocket is opened only after the
 * same NETWORK_FETCH + host-allowlist guard — so a handler can never reach a host
 * outside its descriptor's allowlist (Hard rule 12). The WebSocket factory is
 * injected so the suite connects to nothing.
 *
 * Setup needs the privileged MESSAGE_CONTENT intent enabled in the Discord developer
 * portal (see the catalog `docsUrl`); without it Discord delivers empty message text.
 */

import { assertCapabilities, type Capability } from "../capabilities/index.ts";
import { channelById } from "./catalog.ts";
import { ConnectionError } from "./errors.ts";
import { allowlistedFetch, type FetchFn } from "./fetch.ts";
import { newPairingNonce, PAIRING_TTL_MS } from "./pairing.ts";
import type {
  ChannelDescriptor,
  ChannelHandler,
  ChatSink,
  InboundMessage,
  OutboundIntent,
  Pairable,
  PairingDeps,
  PairingSession,
  PairingUpdate,
  Stoppable,
} from "./types.ts";

const DISCORD_DESCRIPTOR = channelById("discord") as ChannelDescriptor;

/** REST API base (versioned). */
const API_BASE = "https://discord.com/api/v10";
/** The stable Gateway endpoint (JSON encoding, API v10). */
const GATEWAY_URL = "wss://gateway.discord.gg/?v=10&encoding=json";

/**
 * Gateway intents we subscribe to: GUILD_MESSAGES (1<<9), DIRECT_MESSAGES (1<<12),
 * and the privileged MESSAGE_CONTENT (1<<15) so message bodies are populated.
 */
const INTENTS = (1 << 9) | (1 << 12) | (1 << 15);

/** Gateway opcodes (the subset we handle). */
const OP = { DISPATCH: 0, HEARTBEAT: 1, IDENTIFY: 2, RECONNECT: 7, INVALID_SESSION: 9, HELLO: 10 };

/** Delay before reconnecting after a dropped Gateway socket. */
const RECONNECT_DELAY_MS = 1_500;

/**
 * Bot-invite permissions for the pairing URL: View Channel (1<<10),
 * Send Messages (1<<11), Read Message History (1<<16) = 67648. The minimum a
 * transport handler needs to read a channel and reply in it.
 */
const INVITE_PERMISSIONS = (1 << 10) | (1 << 11) | (1 << 16);

/** A minimal Gateway WebSocket — the subset the handler drives. Injected for tests. */
export interface GatewaySocket {
  send(data: string): void;
  close(): void;
}

/** Open a Gateway socket, wiring the lifecycle callbacks. Injected for tests. */
export type GatewayConnect = (
  url: string,
  handlers: {
    readonly onOpen: () => void;
    readonly onMessage: (data: string) => void;
    readonly onClose: () => void;
  },
) => GatewaySocket;

/** Default connect over the platform WebSocket (Bun/browsers). */
const defaultConnect: GatewayConnect = (url, handlers) => {
  const ws = new WebSocket(url);
  ws.addEventListener("open", () => handlers.onOpen());
  ws.addEventListener("message", (e) => handlers.onMessage(String(e.data)));
  ws.addEventListener("close", () => handlers.onClose());
  ws.addEventListener("error", () => handlers.onClose());
  return { send: (data) => ws.send(data), close: () => ws.close() };
};

/** Options for {@link DiscordHandler}. */
export interface DiscordHandlerOptions {
  readonly granted: readonly Capability[];
  readonly fetchFn?: FetchFn;
  readonly vaultKey?: string;
  readonly allowedHosts?: readonly string[];
  /** Gateway connector; defaults to the platform WebSocket. Injected for tests. */
  readonly connect?: GatewayConnect;
}

interface DiscordUser {
  readonly id: string;
  readonly username?: string;
  readonly bot?: boolean;
}

/** The `GET /oauth2/applications/@me` result; `id` is the OAuth2 client id. */
interface OAuth2Application {
  readonly id: string;
}

interface DiscordMessage {
  readonly channel_id: string;
  readonly content?: string;
  readonly author?: DiscordUser;
  readonly timestamp?: string;
}

interface GatewayPayload {
  readonly op: number;
  readonly s?: number | null;
  readonly t?: string | null;
  readonly d?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Parse a Gateway frame, or null when it is not a valid payload. */
function parsePayload(data: string): GatewayPayload | null {
  try {
    const raw: unknown = JSON.parse(data);
    return isRecord(raw) && typeof raw.op === "number" ? (raw as GatewayPayload) : null;
  } catch {
    return null;
  }
}

export class DiscordHandler implements ChannelHandler, Pairable {
  readonly descriptor: ChannelDescriptor = DISCORD_DESCRIPTOR;
  readonly #granted: readonly Capability[];
  readonly #fetchFn: FetchFn | undefined;
  readonly #vaultKey: string;
  readonly #allowedHosts: readonly string[];
  readonly #connect: GatewayConnect;
  #token: string | null = null;
  #selfId: string | null = null;
  #appId: string | undefined = undefined;

  constructor(options: DiscordHandlerOptions) {
    this.#granted = options.granted;
    this.#fetchFn = options.fetchFn;
    this.#vaultKey = options.vaultKey ?? "discord_bot_token";
    this.#allowedHosts = options.allowedHosts ?? this.descriptor.allowedHosts;
    this.#connect = options.connect ?? defaultConnect;
  }

  /** Call the REST API through the allowlisted-fetch seam, returning parsed JSON. */
  async #rest<T>(method: string, path: string, body?: unknown): Promise<T> {
    if (this.#token === null) {
      throw new ConnectionError("not_authenticated", "discord handler is not authenticated");
    }
    const init: RequestInit = {
      method,
      headers: {
        authorization: `Bot ${this.#token}`,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    };
    const res = await allowlistedFetch({
      url: `${API_BASE}${path}`,
      allowedHosts: this.#allowedHosts,
      granted: this.#granted,
      ...(this.#fetchFn !== undefined ? { fetchFn: this.#fetchFn } : {}),
      init,
    });
    if (!res.ok) {
      throw new ConnectionError(
        "invalid_response",
        `discord ${method} ${path} failed: ${res.status}`,
      );
    }
    return (await res.json()) as T;
  }

  /** Load the bot token from the vault and verify it (GET /users/@me). */
  async authenticate(vault: { get(key: string): Promise<string> }): Promise<void> {
    this.#token = await vault.get(this.#vaultKey);
    const me = await this.#rest<DiscordUser>("GET", "/users/@me");
    if (me.bot !== true) {
      throw new ConnectionError("not_authenticated", "discord /users/@me did not return a bot");
    }
    this.#selfId = me.id;
  }

  /** Deliver an outbound intent to a channel via REST. */
  async send(intent: OutboundIntent): Promise<void> {
    await this.#rest("POST", `/channels/${intent.chatId}/messages`, { content: intent.text });
  }

  /**
   * Scan-to-connect: resolve the bot's OAuth2 client id, build an
   * `oauth2/authorize` invite URL (rendered as a QR), and wait for the bot's
   * receive loop to see `pair <nonce>` in a channel — at which point that
   * channel's id is captured automatically (no copying ids). Inbound is observed
   * through the daemon-multiplexed {@link PairingDeps.subscribeInbound} seam, so
   * pairing never opens a second Gateway consumer. The nonce rides the invite URL
   * as a harmless `&state=<nonce>` param (preserved through the OAuth2 flow) so the
   * same value is shown in the QR and expected back in the channel.
   */
  startPairing(deps: PairingDeps): PairingSession {
    let stopped = false;
    let subscription: Stoppable | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let settle!: (update: PairingUpdate) => void;
    const outcome = new Promise<PairingUpdate>((resolve) => {
      settle = resolve;
    });

    const cleanup = (): void => {
      subscription?.stop();
      if (timer !== undefined) clearTimeout(timer);
    };

    const resolveAppId = async (): Promise<string | undefined> => {
      if (this.#appId !== undefined) return this.#appId;
      try {
        const app = await this.#rest<OAuth2Application>("GET", "/oauth2/applications/@me");
        this.#appId = app.id;
        return app.id;
      } catch {
        return undefined;
      }
    };

    const run = async function* (): AsyncGenerator<PairingUpdate> {
      const appId = await resolveAppId();
      if (appId === undefined) {
        yield { status: "error", reason: "could not resolve the discord application id" };
        return;
      }
      if (deps.subscribeInbound === undefined) {
        yield { status: "error", reason: "no inbound stream available for discord pairing" };
        return;
      }
      const nonce = newPairingNonce();
      const expected = `pair ${nonce}`;
      const inviteUrl =
        `https://discord.com/oauth2/authorize?client_id=${appId}` +
        `&scope=bot+applications.commands&permissions=${INVITE_PERMISSIONS}&state=${nonce}`;
      yield {
        status: "awaiting",
        prompt: {
          kind: "link",
          data: inviteUrl,
          humanHint: `Point your phone camera at this code to add the bot to your server, then type 'pair ${nonce}' in the channel you want Vesper to use.`,
          expiresAt: Date.now() + PAIRING_TTL_MS,
        },
      };
      if (stopped) return;
      subscription = deps.subscribeInbound((message) => {
        if (message.channel === "discord" && message.text.trim() === expected) {
          settle({ status: "linked", chatId: message.chatId, label: message.from });
        }
      });
      timer = setTimeout(() => settle({ status: "expired" }), PAIRING_TTL_MS);
      const final = await outcome;
      cleanup();
      yield final;
    };

    return {
      updates: () => run(),
      stop: () => {
        if (stopped) return;
        stopped = true;
        cleanup();
        settle({ status: "expired" });
      },
    };
  }

  /** Assert NETWORK_FETCH and that the Gateway host is allowlisted before connecting. */
  #assertGatewayAllowed(): void {
    assertCapabilities(["NETWORK_FETCH"], this.#granted);
    let host: string | null;
    try {
      host = new URL(GATEWAY_URL).hostname.toLowerCase();
    } catch {
      host = null;
    }
    if (host === null || !this.#allowedHosts.some((h) => h.toLowerCase() === host)) {
      throw new ConnectionError(
        "host_not_allowed",
        `gateway host is not in the channel allowlist [${this.#allowedHosts.join(", ")}]`,
      );
    }
  }

  /**
   * Connect the Gateway and feed each text MESSAGE_CREATE (not from a bot or from
   * ourselves) to `sink`. Heartbeats keep the socket alive; a dropped socket
   * reconnects with a fresh identify while running. Returns a {@link Stoppable}.
   */
  receive(sink: ChatSink): Stoppable {
    this.#assertGatewayAllowed();
    let running = true;
    let socket: GatewaySocket | null = null;
    let heartbeat: ReturnType<typeof setInterval> | null = null;
    let seq: number | null = null;

    const clearHeartbeat = (): void => {
      if (heartbeat !== null) {
        clearInterval(heartbeat);
        heartbeat = null;
      }
    };

    const onMessage = (data: string): void => {
      const payload = parsePayload(data);
      if (payload === null) return;
      if (typeof payload.s === "number") seq = payload.s;

      if (payload.op === OP.HELLO && isRecord(payload.d)) {
        const interval = payload.d.heartbeat_interval;
        if (typeof interval === "number" && interval > 0) {
          heartbeat = setInterval(
            () => socket?.send(JSON.stringify({ op: OP.HEARTBEAT, d: seq })),
            interval,
          );
        }
        socket?.send(
          JSON.stringify({
            op: OP.IDENTIFY,
            d: {
              token: this.#token,
              intents: INTENTS,
              properties: { os: "linux", browser: "vesper", device: "vesper" },
            },
          }),
        );
        return;
      }

      if (payload.op === OP.RECONNECT || payload.op === OP.INVALID_SESSION) {
        socket?.close();
        return;
      }

      if (payload.op === OP.DISPATCH && payload.t === "MESSAGE_CREATE" && isRecord(payload.d)) {
        const msg = payload.d as unknown as DiscordMessage;
        const author = msg.author;
        if (author?.bot === true || author?.id === this.#selfId) return;
        if (typeof msg.content !== "string" || msg.content.length === 0) return;
        const inbound: InboundMessage = {
          channel: "discord",
          chatId: msg.channel_id,
          from: author?.username ?? author?.id ?? "unknown",
          text: msg.content,
          ts: msg.timestamp !== undefined ? Date.parse(msg.timestamp) : Date.now(),
        };
        void Promise.resolve(sink(inbound)).catch(() => {
          // A sink failure (e.g. chatbot down) must not stop ingress.
        });
      }
    };

    const open = (): void => {
      if (!running) return;
      socket = this.#connect(GATEWAY_URL, {
        onOpen: () => {},
        onMessage,
        onClose: () => {
          clearHeartbeat();
          socket = null;
          if (running) setTimeout(open, RECONNECT_DELAY_MS);
        },
      });
    };

    open();
    return {
      stop() {
        running = false;
        clearHeartbeat();
        socket?.close();
        socket = null;
      },
    };
  }
}
