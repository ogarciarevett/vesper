/**
 * Runtime helpers for the pairing (scan-to-connect) capability. The pairing TYPES
 * live in `types.ts` (alongside `ChannelHandler`); this module holds the small
 * runtime pieces: the {@link isPairable} capability guard the daemon coordinator
 * dispatches on, and a URL-safe nonce generator for chat-link deep links.
 */

import type { ChannelHandler, Pairable } from "./types.ts";

/**
 * Default pairing-prompt lifetime (ms). A Telegram deep link never expires on its
 * own, but the SESSION must, so an abandoned pairing cannot linger holding the
 * channel's receive loop. WhatsApp-Web rotates its own QR faster than this.
 */
export const PAIRING_TTL_MS = 5 * 60_000;

/** Runtime guard: does a handler also implement the optional {@link Pairable} capability? */
export function isPairable(handler: ChannelHandler): handler is ChannelHandler & Pairable {
  return typeof (handler as Partial<Pairable>).startPairing === "function";
}

/**
 * A URL-safe pairing nonce (base64url, no padding). Its charset (A-Z a-z 0-9 _ -)
 * is a subset of the Telegram bot deep-link `start` parameter's allowed characters,
 * so the same nonce embeds directly in `https://t.me/<bot>?start=<nonce>` without
 * escaping.
 */
export function newPairingNonce(byteLength = 16): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}
