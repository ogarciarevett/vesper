/**
 * The Telegram channel handler — the only handler BUILT in v1. It is pure
 * transport over the Bot API: `authenticate` loads the bot token from the vault
 * and verifies it with `getMe`; `send` posts a `sendMessage`; `receive` runs a
 * long-poll `getUpdates` loop (no public URL needed — works behind NAT) and feeds
 * each message into the {@link ChatSink}. EVERY HTTP call goes through the injected
 * {@link allowlistedFetch} seam, so the suite fetches to nothing and a handler can
 * never reach a host outside its descriptor's allowlist (Hard rule 12).
 */

import type { Capability } from "../capabilities/index.ts";
import type { Vault } from "../vault/index.ts";
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

/** The Telegram catalog descriptor (non-null — telegram is a built-in catalog id). */
const TELEGRAM_DESCRIPTOR = channelById("telegram") as ChannelDescriptor;

/** Long-poll timeout (seconds) passed to `getUpdates`; the server holds the request open. */
const LONG_POLL_TIMEOUT_S = 25;

/** Options for {@link TelegramHandler}. */
export interface TelegramHandlerOptions {
  /** Capabilities the handler was granted; MUST include NETWORK_FETCH (+ READ_VAULT). */
  readonly granted: readonly Capability[];
  /** The fetch implementation — injected so the suite fetches to nothing. */
  readonly fetchFn?: FetchFn;
  /** Vault KEY the bot token is stored under. Defaults to `telegram_bot_token`. */
  readonly vaultKey?: string;
  /** Hosts the handler may reach; defaults to the descriptor allowlist (narrowed, never widened upstream). */
  readonly allowedHosts?: readonly string[];
}

/** A Telegram `User` (the `getMe` result we care about). */
interface TelegramUser {
  readonly id: number;
  readonly is_bot: boolean;
  readonly username?: string;
}

/** A Telegram `Message` envelope (the subset `getUpdates` hands us). */
interface TelegramMessage {
  readonly message_id: number;
  readonly text?: string;
  readonly chat: { readonly id: number };
  readonly from?: { readonly id: number; readonly username?: string };
  readonly date: number;
}

/** A Telegram `Update` row. */
interface TelegramUpdate {
  readonly update_id: number;
  readonly message?: TelegramMessage;
}

/** The standard `{ ok, result }` Bot API envelope. */
interface TelegramResponse<T> {
  readonly ok: boolean;
  readonly result?: T;
  readonly description?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class TelegramHandler implements ChannelHandler, Pairable {
  readonly descriptor: ChannelDescriptor = TELEGRAM_DESCRIPTOR;
  readonly #granted: readonly Capability[];
  readonly #fetchFn: FetchFn | undefined;
  readonly #vaultKey: string;
  readonly #allowedHosts: readonly string[];
  #token: string | null = null;
  #username: string | undefined = undefined;

  constructor(options: TelegramHandlerOptions) {
    this.#granted = options.granted;
    this.#fetchFn = options.fetchFn;
    this.#vaultKey = options.vaultKey ?? "telegram_bot_token";
    this.#allowedHosts = options.allowedHosts ?? this.descriptor.allowedHosts;
  }

  /** Build a Bot API method URL for the loaded token. */
  #methodUrl(method: string): string {
    return `https://api.telegram.org/bot${this.#token}/${method}`;
  }

  /** Call a Bot API method through the allowlisted-fetch seam and return its `result`. */
  async #call<T>(method: string, body?: unknown): Promise<T> {
    if (this.#token === null) {
      throw new ConnectionError("not_authenticated", "telegram handler is not authenticated");
    }
    const init: RequestInit =
      body === undefined
        ? { method: "GET" }
        : {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          };
    const res = await allowlistedFetch({
      url: this.#methodUrl(method),
      allowedHosts: this.#allowedHosts,
      granted: this.#granted,
      ...(this.#fetchFn !== undefined ? { fetchFn: this.#fetchFn } : {}),
      init,
    });
    let parsed: unknown;
    try {
      parsed = await res.json();
    } catch (cause) {
      throw new ConnectionError("invalid_response", `telegram ${method} returned non-JSON`, {
        cause,
      });
    }
    if (!isRecord(parsed) || parsed.ok !== true) {
      const description =
        isRecord(parsed) && typeof parsed.description === "string"
          ? parsed.description
          : `status ${res.status}`;
      throw new ConnectionError("invalid_response", `telegram ${method} failed: ${description}`);
    }
    return (parsed as TelegramResponse<T>).result as T;
  }

  /** Load the bot token from the vault and verify it with `getMe`. */
  async authenticate(vault: Vault): Promise<void> {
    this.#token = await vault.get(this.#vaultKey);
    const me = await this.#call<TelegramUser>("getMe");
    if (!me.is_bot) {
      throw new ConnectionError("not_authenticated", "telegram getMe did not return a bot");
    }
    this.#username = me.username;
  }

  /** Deliver an outbound intent via `sendMessage`. */
  async send(intent: OutboundIntent): Promise<void> {
    await this.#call("sendMessage", { chat_id: intent.chatId, text: intent.text });
  }

  /**
   * Scan-to-connect: build a `t.me/<bot>?start=<nonce>` deep link, render it as a
   * QR, and wait for the bot's long-poll to receive `/start <nonce>` — at which
   * point the user's chat id is captured automatically (no copying ids). Inbound
   * is observed through the daemon-multiplexed {@link PairingDeps.subscribeInbound}
   * seam, so pairing never opens a second `getUpdates` consumer.
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

    const resolveUsername = async (): Promise<string | undefined> => {
      if (this.#username !== undefined) return this.#username;
      try {
        const me = await this.#call<TelegramUser>("getMe");
        this.#username = me.username;
        return me.username;
      } catch {
        return undefined;
      }
    };

    const run = async function* (): AsyncGenerator<PairingUpdate> {
      const username = await resolveUsername();
      if (username === undefined) {
        yield { status: "error", reason: "telegram bot has no username; cannot build a deep link" };
        return;
      }
      if (deps.subscribeInbound === undefined) {
        yield { status: "error", reason: "no inbound stream available for telegram pairing" };
        return;
      }
      const nonce = newPairingNonce();
      const expected = `/start ${nonce}`;
      yield {
        status: "awaiting",
        prompt: {
          kind: "link",
          data: `https://t.me/${username}?start=${nonce}`,
          humanHint:
            "Point your phone camera at this code (or open the link) to open the bot in Telegram, then tap Start.",
          expiresAt: Date.now() + PAIRING_TTL_MS,
        },
      };
      if (stopped) return;
      subscription = deps.subscribeInbound((message) => {
        if (message.channel === "telegram" && message.text.trim() === expected) {
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

  /**
   * Start a long-poll `getUpdates` loop, handing each text message to `sink`.
   * Returns a {@link Stoppable}; `stop()` halts the loop after the in-flight poll
   * settles. A failed poll is isolated (the loop continues) so a transient error
   * does not kill ingress.
   */
  receive(sink: ChatSink): Stoppable {
    let running = true;
    let offset = 0;

    const loop = async (): Promise<void> => {
      while (running) {
        // Yield to the event loop each iteration so a cooperative stop() and any
        // pending timers actually run. Without this, an instantly-resolving poll
        // (a mock, or a server that ignores the long-poll timeout) re-arms purely on
        // the microtask queue, starving macrotasks — the loop never sees running=false
        // and the process never quiesces.
        await new Promise((resolve) => setTimeout(resolve, 0));
        let updates: TelegramUpdate[];
        try {
          updates = await this.#call<TelegramUpdate[]>("getUpdates", {
            offset,
            timeout: LONG_POLL_TIMEOUT_S,
          });
        } catch {
          // Isolate a transient poll failure; yield, then retry while running.
          await new Promise((resolve) => setTimeout(resolve, 1_000));
          continue;
        }
        for (const update of updates) {
          offset = Math.max(offset, update.update_id + 1);
          const msg = update.message;
          if (msg?.text === undefined) continue;
          const inbound: InboundMessage = {
            channel: "telegram",
            chatId: String(msg.chat.id),
            from: msg.from?.username ?? String(msg.from?.id ?? "unknown"),
            text: msg.text,
            ts: msg.date * 1_000,
          };
          try {
            await sink(inbound);
          } catch {
            // A sink failure (e.g. chatbot down) must not stop ingress.
          }
        }
      }
    };

    void loop();
    return {
      stop() {
        running = false;
      },
    };
  }
}
