/**
 * The channel PLUGIN registry — the single extension point for messaging channels.
 *
 * Adding a channel is: (1) implement a {@link ChannelHandler}, (2) add one
 * {@link ChannelPlugin} entry to {@link CHANNEL_PLUGINS}, (3) flip its catalog
 * status to "ready". The daemon, CLI, and UI all iterate this registry to learn
 * which channels are *available* (a handler ships), so none of them change when a
 * channel is added — channels are a plugin. Telegram, Discord, WhatsApp (Cloud API),
 * and Signal (signal-cli) ship built-in plugins; WhatsApp-Web registers at runtime.
 */

import type { Capability } from "../capabilities/index.ts";
import { DiscordHandler } from "./discord.ts";
import type { FetchFn } from "./fetch.ts";
import { SignalHandler } from "./signal.ts";
import { TelegramHandler } from "./telegram.ts";
import type { ChannelHandler, ChannelId } from "./types.ts";
import { WhatsAppHandler } from "./whatsapp.ts";

/** Capabilities a channel handler is granted: NETWORK_FETCH (egress) + READ_VAULT (token). */
export const CHANNEL_GRANTS: readonly Capability[] = ["NETWORK_FETCH", "READ_VAULT"];

/** Inputs a plugin needs to construct its handler for one configured channel. */
export interface ChannelBuildOptions {
  readonly granted: readonly Capability[];
  /** Vault KEY the credential is stored under (never the value). */
  readonly vaultKey: string;
  /** Hosts the handler may reach — already narrowed against the catalog descriptor. */
  readonly allowedHosts: readonly string[];
  /** Non-secret per-channel params (e.g. WhatsApp `phoneNumberId`). */
  readonly params?: Readonly<Record<string, string>>;
  /** Injected fetch so the suite fetches to nothing; omit to use the real fetch. */
  readonly fetchFn?: FetchFn;
}

/** A pluggable channel: an id + a factory that builds its handler. */
export interface ChannelPlugin {
  readonly id: ChannelId;
  /** True when {@link build} returns a handler that also implements `Pairable` (QR onboarding). */
  readonly pairable?: boolean;
  /**
   * Whether pairing observes the daemon's inbound stream (default `true`, for chat-link
   * channels like Telegram/Discord that watch for a `/start <nonce>` message). Set `false`
   * for SELF-DRIVING pairing (e.g. WhatsApp-Web, where the handler drives its own socket and
   * establishes auth via the scan itself) — the coordinator then skips the authenticate
   * precondition and the transient receive loop.
   */
  readonly pairingNeedsInbound?: boolean;
  build(opts: ChannelBuildOptions): ChannelHandler;
}

/** Built-in channel plugins: Telegram, Discord, WhatsApp (Cloud API), Signal (signal-cli). */
export const CHANNEL_PLUGINS: readonly ChannelPlugin[] = [
  {
    id: "telegram",
    pairable: true,
    build: (opts) =>
      new TelegramHandler({
        granted: opts.granted,
        vaultKey: opts.vaultKey,
        allowedHosts: opts.allowedHosts,
        ...(opts.fetchFn !== undefined ? { fetchFn: opts.fetchFn } : {}),
      }),
  },
  {
    id: "discord",
    pairable: true,
    build: (opts) =>
      new DiscordHandler({
        granted: opts.granted,
        vaultKey: opts.vaultKey,
        allowedHosts: opts.allowedHosts,
        ...(opts.fetchFn !== undefined ? { fetchFn: opts.fetchFn } : {}),
      }),
  },
  {
    id: "whatsapp",
    build: (opts) =>
      new WhatsAppHandler({
        granted: opts.granted,
        vaultKey: opts.vaultKey,
        allowedHosts: opts.allowedHosts,
        ...(opts.params?.phoneNumberId !== undefined
          ? { phoneNumberId: opts.params.phoneNumberId }
          : {}),
        ...(opts.fetchFn !== undefined ? { fetchFn: opts.fetchFn } : {}),
      }),
  },
  {
    // Signal runs through the local signal-cli binary (no HTTP, no SDK). Self-driving
    // device-link pairing, so the coordinator skips the inbound precondition.
    id: "signal",
    pairable: true,
    pairingNeedsInbound: false,
    build: (opts) => new SignalHandler({ granted: opts.granted, vaultKey: opts.vaultKey }),
  },
];

/**
 * Runtime-registered OPTIONAL plugins (e.g. the opt-in `@vesper/channel-whatsapp-web`
 * package). Kept separate from the built-ins so core ships ZERO optional dependencies — the
 * daemon/CLI lazily imports the package at boot and registers its plugin here, and core never
 * imports it. A channel with no built-in and no registered plugin reports `available: false`.
 */
const REGISTERED_PLUGINS = new Map<string, ChannelPlugin>();

/** Register an optional channel plugin at runtime (idempotent; a re-register replaces). */
export function registerChannelPlugin(plugin: ChannelPlugin): void {
  REGISTERED_PLUGINS.set(plugin.id, plugin);
}

/** Remove a runtime-registered optional plugin (test/teardown helper). */
export function unregisterChannelPlugin(id: string): void {
  REGISTERED_PLUGINS.delete(id);
}

/** Look up a channel plugin by id — built-ins first, then runtime-registered optionals. */
export function channelPluginById(id: string): ChannelPlugin | undefined {
  return CHANNEL_PLUGINS.find((plugin) => plugin.id === id) ?? REGISTERED_PLUGINS.get(id);
}
