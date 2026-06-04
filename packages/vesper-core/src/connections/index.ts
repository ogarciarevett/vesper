// @vesper/core — Connections layer public surface (messaging channels + MCP catalog).

export {
  type ConnectionEventKind,
  recordConnectionEvent,
  stripSensitive,
} from "./audit.ts";
export {
  CHANNEL_CATALOG,
  channelById,
  isChannelId,
  isMcpId,
  MCP_CATALOG,
  type McpDescriptor,
  mcpById,
} from "./catalog.ts";
export {
  DiscordHandler,
  type DiscordHandlerOptions,
  type GatewayConnect,
  type GatewaySocket,
} from "./discord.ts";
export { ConnectionError, type ConnectionErrorReason } from "./errors.ts";
export {
  type AllowlistedFetchOptions,
  allowlistedFetch,
  type FetchFn,
} from "./fetch.ts";
export { isPairable, newPairingNonce, PAIRING_TTL_MS } from "./pairing.ts";
export {
  CHANNEL_GRANTS,
  CHANNEL_PLUGINS,
  type ChannelBuildOptions,
  type ChannelPlugin,
  channelPluginById,
  registerChannelPlugin,
  unregisterChannelPlugin,
} from "./plugins.ts";
export { ChannelRegistry } from "./registry.ts";
export {
  type ChannelState,
  type ChannelWiring,
  channelStates,
} from "./state.ts";
export { TelegramHandler, type TelegramHandlerOptions } from "./telegram.ts";
export type {
  ChannelDescriptor,
  ChannelHandler,
  ChannelId,
  ChannelStatus,
  ChannelTransport,
  ChatSink,
  InboundMessage,
  OutboundIntent,
  Pairable,
  PairingDeps,
  PairingPrompt,
  PairingSession,
  PairingUpdate,
  Stoppable,
} from "./types.ts";
export { WhatsAppHandler, type WhatsAppHandlerOptions } from "./whatsapp.ts";
