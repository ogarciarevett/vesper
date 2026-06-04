/**
 * The WhatsApp channel handler — SEND-ONLY (v1) over the Meta WhatsApp Cloud API.
 *
 * WhatsApp has no free behind-NAT inbound: receiving requires a public webhook (a
 * tunnel) or a reverse-engineered WhatsApp-Web client (rejected — heavy dependency +
 * ToS/ban risk). So v1 ships outbound only: `send` posts a text message via the Cloud
 * API; `receive` is a no-op (two-way is a follow-up that adds a webhook endpoint).
 * Every HTTP call routes through the injected {@link allowlistedFetch} seam.
 *
 * The Cloud API needs the business `phoneNumberId` (the SENDER) in addition to the
 * access token — it is a NON-secret param (config `params.phoneNumberId`), while the
 * token stays in the vault. `OutboundIntent.chatId` is the RECIPIENT's phone number.
 */

import type { Capability } from "../capabilities/index.ts";
import { channelById } from "./catalog.ts";
import { ConnectionError } from "./errors.ts";
import { allowlistedFetch, type FetchFn } from "./fetch.ts";
import type {
  ChannelDescriptor,
  ChannelHandler,
  ChatSink,
  OutboundIntent,
  Stoppable,
} from "./types.ts";

const WHATSAPP_DESCRIPTOR = channelById("whatsapp") as ChannelDescriptor;

/** Graph API base (versioned). */
const API_BASE = "https://graph.facebook.com/v21.0";

/** Options for {@link WhatsAppHandler}. */
export interface WhatsAppHandlerOptions {
  readonly granted: readonly Capability[];
  readonly fetchFn?: FetchFn;
  readonly vaultKey?: string;
  readonly allowedHosts?: readonly string[];
  /** The Cloud API business phone-number id (the sender). Required to send. */
  readonly phoneNumberId?: string;
}

export class WhatsAppHandler implements ChannelHandler {
  readonly descriptor: ChannelDescriptor = WHATSAPP_DESCRIPTOR;
  readonly #granted: readonly Capability[];
  readonly #fetchFn: FetchFn | undefined;
  readonly #vaultKey: string;
  readonly #allowedHosts: readonly string[];
  readonly #phoneNumberId: string | undefined;
  #token: string | null = null;

  constructor(options: WhatsAppHandlerOptions) {
    this.#granted = options.granted;
    this.#fetchFn = options.fetchFn;
    this.#vaultKey = options.vaultKey ?? "whatsapp_access_token";
    this.#allowedHosts = options.allowedHosts ?? this.descriptor.allowedHosts;
    this.#phoneNumberId = options.phoneNumberId;
  }

  #requirePhoneNumberId(): string {
    if (this.#phoneNumberId === undefined || this.#phoneNumberId.length === 0) {
      throw new ConnectionError(
        "not_authenticated",
        "whatsapp needs a phoneNumberId param (set it with `vesper connections set whatsapp phoneNumberId=<id>`)",
      );
    }
    return this.#phoneNumberId;
  }

  /** Call the Cloud API through the allowlisted-fetch seam, returning the Response. */
  async #call(method: string, path: string, body?: unknown): Promise<Response> {
    if (this.#token === null) {
      throw new ConnectionError("not_authenticated", "whatsapp handler is not authenticated");
    }
    const init: RequestInit = {
      method,
      headers: {
        authorization: `Bearer ${this.#token}`,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    };
    return allowlistedFetch({
      url: `${API_BASE}${path}`,
      allowedHosts: this.#allowedHosts,
      granted: this.#granted,
      ...(this.#fetchFn !== undefined ? { fetchFn: this.#fetchFn } : {}),
      init,
    });
  }

  /** Load the token from the vault and verify token + phoneNumberId with a GET. */
  async authenticate(vault: { get(key: string): Promise<string> }): Promise<void> {
    const phoneNumberId = this.#requirePhoneNumberId();
    this.#token = await vault.get(this.#vaultKey);
    const res = await this.#call("GET", `/${phoneNumberId}?fields=id`);
    if (!res.ok) {
      throw new ConnectionError(
        "not_authenticated",
        `whatsapp could not verify the phone number (status ${res.status})`,
      );
    }
  }

  /** Deliver a text message to a recipient (intent.chatId is the recipient's number). */
  async send(intent: OutboundIntent): Promise<void> {
    const phoneNumberId = this.#requirePhoneNumberId();
    const res = await this.#call("POST", `/${phoneNumberId}/messages`, {
      messaging_product: "whatsapp",
      to: intent.chatId,
      type: "text",
      text: { body: intent.text },
    });
    if (!res.ok) {
      throw new ConnectionError("invalid_response", `whatsapp send failed: ${res.status}`);
    }
  }

  /**
   * Inbound is not supported in v1 (WhatsApp needs a public webhook). Returns a
   * no-op {@link Stoppable} so the registry can hold a send-only handler uniformly.
   */
  receive(_sink: ChatSink): Stoppable {
    return { stop() {} };
  }
}
