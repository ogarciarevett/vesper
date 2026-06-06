/**
 * Channel AUTO-ONBOARDING specs — the pure, host-agnostic half of "Vesper sets up the
 * channel for you." For a token channel (Telegram, Discord), {@link buildPrompt} is the
 * agentic browser-task the user's CLI runs (it drives the provider's web UI with its
 * agent-browser skill — the brain stays the CLI, Hard rule 12), and {@link parseToken}
 * reads the minted token back from the CLI's final output.
 *
 * SAFETY: {@link parseToken} is STRICT — it returns a credential ONLY on a confident
 * per-provider format match, never from free-form prose. A hallucinated or wrong token
 * therefore parses to `null` and the host falls back to manual entry, instead of silently
 * storing garbage as the channel credential.
 *
 * Device-link channels (WhatsApp-personal, Signal) need NO token and are NOT here — they
 * onboard through the existing pairing (QR) flow.
 */

import type { ChannelId } from "./types.ts";

/**
 * Sentinel the agentic CLI is told to emit when it hits a login / 2FA / captcha wall it
 * cannot pass autonomously. The host maps it to a graceful "finish in the browser, then
 * enter the token manually" step rather than an error.
 */
export const NEED_USER_LOGIN = "NEED_USER_LOGIN";

/** Default wall-clock budget for one agentic setup turn (browser work runs for minutes). */
export const SETUP_TIMEOUT_MS = 5 * 60_000;

/**
 * A streamed update from an in-flight channel SETUP. Mirrors `PairingUpdate`'s
 * terminal/non-terminal shape so the route + UI render both flows the same way.
 * `working` may fire several times; `configured` / `awaiting_user` / `error` are terminal.
 * `awaiting_user` is the graceful fallback: automation could not finish, so the surface
 * shows the manual token field (it is NOT an error).
 */
export type SetupUpdate =
  | { readonly status: "working"; readonly message: string }
  | { readonly status: "configured" }
  | { readonly status: "awaiting_user"; readonly reason: string }
  | { readonly status: "error"; readonly reason: string };

/** A running setup attempt. `updates()` yields until terminal; `stop()` cancels (idempotent). */
export interface SetupSession {
  updates(): AsyncIterable<SetupUpdate>;
  stop(): void;
}

/** Per-channel auto-onboarding spec: how to drive the browser + how to read the token back. */
export interface ChannelSetupSpec {
  readonly id: ChannelId;
  /** The agentic browser-task prompt instructing the CLI to mint a token via agent-browser. */
  buildPrompt(displayName: string): string;
  /** STRICT parse: the token ONLY on a confident format match, else null. */
  parseToken(output: string): string | null;
}

/**
 * Telegram bot token: `<6-12 digit bot id>:<35 url-safe chars>` from @BotFather. The
 * id length and the fixed-ish secret length make this a low-false-positive match.
 */
const TELEGRAM_TOKEN_RE = /\b(\d{6,12}:[A-Za-z0-9_-]{30,})\b/;

/**
 * Discord bot token: three url-safe base64 segments separated by dots
 * (`<base64 id>.<base64 ts>.<base64 hmac>`). Strict three-part shape to avoid matching
 * ordinary dotted text.
 */
const DISCORD_TOKEN_RE = /\b([A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{20,})\b/;

/** Shared closing instruction: emit ONLY the token, or the sentinel when blocked. */
function tokenContract(tokenDescription: string): string {
  return [
    `Output ONLY the ${tokenDescription} on the final line, with no surrounding text, quotes,`,
    `or explanation. If you cannot finish for ANY reason (login required, a 2FA code or`,
    `captcha you cannot pass, the page changed, a step failed), output exactly`,
    `${NEED_USER_LOGIN} and nothing else.`,
  ].join(" ");
}

const TELEGRAM_SETUP: ChannelSetupSpec = {
  id: "telegram",
  buildPrompt: (displayName) =>
    [
      `You are setting up the user's ${displayName} bot for a local automation app. Use your`,
      `agent-browser tool/skill to drive a real web browser. Steps:`,
      `1. Open the Telegram web app and confirm the user is already signed in.`,
      `2. Open a chat with @BotFather.`,
      `3. Send "/newbot" and follow the prompts to create a new bot (a friendly name, and a`,
      `   unique username ending in "bot").`,
      `4. BotFather replies with an HTTP API token shaped like 123456789:AA...`,
      tokenContract("bot token"),
    ].join("\n"),
  parseToken: (output) => output.match(TELEGRAM_TOKEN_RE)?.[1] ?? null,
};

const DISCORD_SETUP: ChannelSetupSpec = {
  id: "discord",
  buildPrompt: (displayName) =>
    [
      `You are setting up the user's ${displayName} bot for a local automation app. Use your`,
      `agent-browser tool/skill to drive a real web browser. Steps:`,
      `1. Open the Discord Developer Portal (discord.com/developers/applications) and confirm`,
      `   the user is signed in.`,
      `2. Create a New Application named "Vesper" (add a unique suffix if the name is taken).`,
      `3. Open its "Bot" page, enable the "Message Content Intent", and reveal/reset the token.`,
      `4. The bot token is three url-safe segments separated by dots.`,
      tokenContract("bot token"),
    ].join("\n"),
  parseToken: (output) => output.match(DISCORD_TOKEN_RE)?.[1] ?? null,
};

/** Channels with an automated browser-driven setup (token channels only). */
export const CHANNEL_SETUPS: readonly ChannelSetupSpec[] = [TELEGRAM_SETUP, DISCORD_SETUP];

/** Look up a channel's setup spec by id, or undefined when it has no automated setup. */
export function channelSetupById(id: string): ChannelSetupSpec | undefined {
  return CHANNEL_SETUPS.find((s) => s.id === id);
}
