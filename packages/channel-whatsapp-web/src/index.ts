/**
 * `@vesper/channel-whatsapp-web` — the OPT-IN home of the Baileys dependency that
 * adds WhatsApp-Web (personal-account) QR pairing. Core ships ZERO of this; the
 * daemon/CLI lazily imports this package at boot and calls
 * `registerChannelPlugin(whatsappWebPlugin)`.
 *
 * The plugin is SELF-DRIVING (`pairingNeedsInbound: false`): the handler drives its
 * own Baileys socket and establishes auth via the scan itself, so the coordinator
 * skips the `authenticate` precondition and the transient receive loop.
 */

import type { ChannelPlugin } from "@vesper/core";
import { WhatsAppWebHandler } from "./handler.ts";

export {
  type WASocket,
  type WASocketConfig,
  type WASocketFactory,
  WhatsAppWebHandler,
  type WhatsAppWebHandlerOptions,
} from "./handler.ts";
export { makeVaultAuthState, type VaultAuthState } from "./vault-auth-state.ts";

/** The opt-in WhatsApp-Web channel plugin. Register it at boot to make the channel available. */
export const whatsappWebPlugin: ChannelPlugin = {
  id: "whatsapp-web",
  pairable: true,
  pairingNeedsInbound: false,
  build: (opts) => new WhatsAppWebHandler({ granted: opts.granted, vaultKey: opts.vaultKey }),
};
