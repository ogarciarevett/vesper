/**
 * Pure per-channel state derivation, shared by the `vesper connections list` CLI and
 * the `GET /api/connections` route so both report identical, honest status. No I/O:
 * the caller supplies the non-secret wiring (config), the stored vault KEY names, and
 * which handler ids are currently running in the daemon's registry.
 */

import { CHANNEL_CATALOG } from "./catalog.ts";
import { channelPluginById } from "./plugins.ts";
import type { ChannelId, ChannelStatus } from "./types.ts";

/** Non-secret per-channel wiring (the config shape; the token lives in the vault). */
export interface ChannelWiring {
  readonly enabled: boolean;
  readonly vaultKey: string;
  readonly allowedHosts: readonly string[];
}

/** A channel's resolved state for display — catalog metadata + live truth. */
export interface ChannelState {
  readonly id: ChannelId;
  readonly displayName: string;
  /** Catalog intent ("ready"/"deferred") — aspirational; `available` is the real gate. */
  readonly status: ChannelStatus;
  /** A handler ships for this channel (a plugin exists) — the honest availability gate. */
  readonly available: boolean;
  /** A credential is stored in the vault under this channel's key. */
  readonly configured: boolean;
  /** The user has enabled this channel in config. */
  readonly enabled: boolean;
  /** A handler for this channel is currently running in the daemon registry. */
  readonly running: boolean;
  /** The handler supports QR/link pairing (scan-to-connect). */
  readonly pairable: boolean;
  readonly docsUrl: string;
  readonly allowedHosts: readonly string[];
}

/** Derive every catalog channel's state from wiring + stored keys + running ids. */
export function channelStates(opts: {
  readonly wiring?: Readonly<Record<string, ChannelWiring>>;
  readonly storedKeys?: readonly string[];
  readonly runningIds?: readonly string[];
}): ChannelState[] {
  const stored = new Set(opts.storedKeys ?? []);
  const running = new Set(opts.runningIds ?? []);
  return CHANNEL_CATALOG.map((descriptor) => {
    const wiring = opts.wiring?.[descriptor.id];
    const vaultKey = wiring?.vaultKey ?? descriptor.vaultKeys[0];
    const plugin = channelPluginById(descriptor.id);
    const available = plugin !== undefined;
    return {
      id: descriptor.id,
      displayName: descriptor.displayName,
      status: descriptor.status,
      available,
      configured: vaultKey !== undefined && stored.has(vaultKey),
      enabled: wiring?.enabled === true,
      // A channel with no shipped handler can never run, regardless of the input.
      running: available && running.has(descriptor.id),
      pairable: plugin?.pairable === true,
      docsUrl: descriptor.docsUrl,
      allowedHosts: wiring?.allowedHosts ?? descriptor.allowedHosts,
    };
  });
}
