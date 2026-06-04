/**
 * The channel PLUGIN registry — the single extension point for messaging channels.
 *
 * Adding a channel is: (1) implement a {@link ChannelHandler}, (2) add one
 * {@link ChannelPlugin} entry to {@link CHANNEL_PLUGINS}, (3) flip its catalog
 * status to "ready". The daemon, CLI, and UI all iterate this registry to learn
 * which channels are *available* (a handler ships), so none of them change when a
 * channel is added — channels are a plugin. Telegram is the only handler shipped
 * today; Discord/WhatsApp/Signal are catalog entries with no plugin yet.
 */

import type { Capability } from "../capabilities/index.ts";
import type { FetchFn } from "./fetch.ts";
import { TelegramHandler } from "./telegram.ts";
import type { ChannelHandler, ChannelId } from "./types.ts";

/** Capabilities a channel handler is granted: NETWORK_FETCH (egress) + READ_VAULT (token). */
export const CHANNEL_GRANTS: readonly Capability[] = ["NETWORK_FETCH", "READ_VAULT"];

/** Inputs a plugin needs to construct its handler for one configured channel. */
export interface ChannelBuildOptions {
  readonly granted: readonly Capability[];
  /** Vault KEY the credential is stored under (never the value). */
  readonly vaultKey: string;
  /** Hosts the handler may reach — already narrowed against the catalog descriptor. */
  readonly allowedHosts: readonly string[];
  /** Injected fetch so the suite fetches to nothing; omit to use the real fetch. */
  readonly fetchFn?: FetchFn;
}

/** A pluggable channel: an id + a factory that builds its handler. */
export interface ChannelPlugin {
  readonly id: ChannelId;
  build(opts: ChannelBuildOptions): ChannelHandler;
}

/** Built-in channel plugins. Telegram is the only handler shipped today. */
export const CHANNEL_PLUGINS: readonly ChannelPlugin[] = [
  {
    id: "telegram",
    build: (opts) =>
      new TelegramHandler({
        granted: opts.granted,
        vaultKey: opts.vaultKey,
        allowedHosts: opts.allowedHosts,
        ...(opts.fetchFn !== undefined ? { fetchFn: opts.fetchFn } : {}),
      }),
  },
];

/** Look up a channel plugin by id, or undefined when no handler ships for it. */
export function channelPluginById(id: string): ChannelPlugin | undefined {
  return CHANNEL_PLUGINS.find((plugin) => plugin.id === id);
}
