/**
 * Curated, code-reviewed catalogs — the single source of truth for channels and
 * MCP servers. User input selects an id (a KEY); it never supplies an arbitrary
 * host or server URL (same trust posture as the agent install catalog).
 *
 * Channels: telegram + discord are `ready` (a handler exists / shares the
 * contract); whatsapp + signal are `deferred` (catalog entry + tutorial only).
 */

import type { ChannelDescriptor, ChannelId } from "./types.ts";

/** Immutable channel catalog. */
export const CHANNEL_CATALOG: readonly ChannelDescriptor[] = [
  {
    id: "telegram",
    displayName: "Telegram",
    transport: "long-poll",
    allowedHosts: ["api.telegram.org"],
    vaultKeys: ["telegram_bot_token"],
    docsUrl: "https://core.telegram.org/bots#how-do-i-create-a-bot",
    status: "ready",
  },
  {
    id: "discord",
    displayName: "Discord",
    transport: "bot-api",
    // discord.com is the REST API; gateway.discord.gg is the receive WebSocket.
    allowedHosts: ["discord.com", "gateway.discord.gg"],
    vaultKeys: ["discord_bot_token"],
    docsUrl: "https://discord.com/developers/docs/getting-started",
    status: "ready",
  },
  {
    id: "whatsapp",
    displayName: "WhatsApp",
    // Send-only v1 over the Cloud API (REST). Inbound (a public webhook) is deferred.
    transport: "bot-api",
    allowedHosts: ["graph.facebook.com"],
    vaultKeys: ["whatsapp_access_token"],
    docsUrl: "https://developers.facebook.com/docs/whatsapp/cloud-api",
    status: "ready",
  },
  {
    id: "signal",
    displayName: "Signal",
    transport: "local-cli",
    // Signal runs through a local signal-cli process, not a hosted host. The
    // localhost REST bridge is the only egress; it is still declared so the
    // allowlist seam holds (a deferred handler starts nothing in v1).
    allowedHosts: ["127.0.0.1"],
    vaultKeys: ["signal_account"],
    docsUrl: "https://github.com/AsamK/signal-cli",
    status: "deferred",
  },
] as const;

/** Look up a channel descriptor by id, or undefined when not in the catalog. */
export function channelById(id: string): ChannelDescriptor | undefined {
  return CHANNEL_CATALOG.find((d) => d.id === id);
}

/** Type-guard: true iff `id` is a known catalog {@link ChannelId}. */
export function isChannelId(id: string): id is ChannelId {
  return CHANNEL_CATALOG.some((d) => d.id === id);
}

/**
 * An MCP server catalog entry. The user opts a server in by id; v1 RECORDS the
 * opt-in + any credential and shows status — it does NOT proxy MCP traffic
 * (wiring the server into a CLI adapter's own MCP config is the adapter's concern).
 */
export interface McpDescriptor {
  readonly id: string;
  readonly displayName: string;
  readonly docsUrl: string;
  /** Vault KEY names this server needs (NEVER the values); empty when none. */
  readonly vaultKeys: readonly string[];
  /** Hosts this server is known to reach (informational in v1; no proxying). */
  readonly allowedHosts: readonly string[];
}

/** Immutable MCP catalog — the 10 seed ids observed in the operating environment. */
export const MCP_CATALOG: readonly McpDescriptor[] = [
  {
    id: "linear",
    displayName: "Linear",
    docsUrl: "https://linear.app/docs/mcp",
    vaultKeys: [],
    allowedHosts: ["mcp.linear.app"],
  },
  {
    id: "notion",
    displayName: "Notion",
    docsUrl: "https://developers.notion.com",
    vaultKeys: [],
    allowedHosts: ["mcp.notion.com"],
  },
  {
    id: "gmail",
    displayName: "Gmail",
    docsUrl: "https://developers.google.com/gmail/api",
    vaultKeys: [],
    allowedHosts: ["gmail.googleapis.com"],
  },
  {
    id: "google-calendar",
    displayName: "Google Calendar",
    docsUrl: "https://developers.google.com/calendar",
    vaultKeys: [],
    allowedHosts: ["www.googleapis.com"],
  },
  {
    id: "google-drive",
    displayName: "Google Drive",
    docsUrl: "https://developers.google.com/drive",
    vaultKeys: [],
    allowedHosts: ["www.googleapis.com"],
  },
  {
    id: "refero",
    displayName: "Refero",
    docsUrl: "https://refero.design",
    vaultKeys: [],
    allowedHosts: ["mcp.refero.design"],
  },
  {
    id: "bigdata",
    displayName: "Bigdata.com",
    docsUrl: "https://bigdata.com",
    vaultKeys: [],
    allowedHosts: ["mcp.bigdata.com"],
  },
  {
    id: "fmp",
    displayName: "Financial Modeling Prep",
    docsUrl: "https://site.financialmodelingprep.com/developer/docs",
    vaultKeys: [],
    allowedHosts: ["mcp.financialmodelingprep.com"],
  },
  {
    id: "ziprecruiter",
    displayName: "ZipRecruiter",
    docsUrl: "https://www.ziprecruiter.com/publishers",
    vaultKeys: [],
    allowedHosts: ["api.ziprecruiter.com"],
  },
  {
    id: "excalidraw",
    displayName: "Excalidraw",
    docsUrl: "https://docs.excalidraw.com",
    vaultKeys: [],
    allowedHosts: ["excalidraw.com"],
  },
] as const;

/** Look up an MCP descriptor by id, or undefined when not in the catalog. */
export function mcpById(id: string): McpDescriptor | undefined {
  return MCP_CATALOG.find((d) => d.id === id);
}

/** Type-guard: true iff `id` is a known catalog MCP server id. */
export function isMcpId(id: string): boolean {
  return MCP_CATALOG.some((d) => d.id === id);
}
