/// <reference lib="dom" />
import { ICONS } from "../shell/icons.ts";
import { h, type SectionContext, type SectionModule, sectionHeader } from "../shell/section.ts";

/** One row of `GET /api/connections` (mirrors core `ChannelState`). */
interface ChannelRow {
  readonly id: string;
  readonly displayName: string;
  readonly available: boolean;
  readonly configured: boolean;
  readonly enabled: boolean;
  readonly running: boolean;
  readonly docsUrl: string;
}

/** MCP servers stay a read-only catalog this slice (no enable/disable yet). */
const MCP: readonly string[] = [
  "Linear",
  "Notion",
  "Gmail",
  "Google Calendar",
  "Google Drive",
  "Refero",
  "Bigdata.com",
  "Financial Modeling Prep",
  "ZipRecruiter",
  "Excalidraw",
];

/** A badge describing a channel's live state (the honest gate is `available`). */
function channelBadge(c: ChannelRow): HTMLElement {
  if (!c.available) return h("span", { class: "badge" }, "soon");
  if (c.running) {
    return h("span", { class: "badge ok" }, h("span", { class: "status-dot" }), "connected");
  }
  if (c.enabled && c.configured) return h("span", { class: "badge danger" }, "check token");
  if (c.configured) return h("span", { class: "badge" }, "disabled");
  return h("span", { class: "badge" }, "needs token");
}

/** A one-line, accurate next step for a channel (CLI is the trusted setup surface). */
function channelHint(c: ChannelRow): HTMLElement | null {
  if (!c.available) return h("span", { class: "muted" }, "handler coming soon");
  const hint = c.configured
    ? c.enabled
      ? `restart the daemon to apply, or check the token: vesper connections test ${c.id}`
      : `enable it: vesper connections enable ${c.id}`
    : `add a token: vesper connections set ${c.id}`;
  return h(
    "span",
    { class: "muted" },
    `${hint}  ·  `,
    h("a", { href: c.docsUrl, target: "_blank", rel: "noreferrer" }, "setup guide"),
  );
}

function channelRow(c: ChannelRow): HTMLElement {
  return h(
    "div",
    { class: "kv", style: "flex-direction:column;align-items:stretch;gap:4px" },
    h(
      "div",
      { style: "display:flex;align-items:center;justify-content:space-between" },
      h("span", { class: "k" }, c.displayName),
      channelBadge(c),
    ),
    channelHint(c) ?? h("span"),
  );
}

/**
 * Channels — the messaging surfaces (live, from `GET /api/connections`) and the MCP
 * catalog. Telegram is the only channel with a shipped handler today; others read
 * "soon". Credentials are set with the `vesper connections` CLI (stdin-only), never
 * the browser, so this page is read-only status + accurate next steps.
 */
export const channelsSection: SectionModule = {
  id: "channels",
  title: "Channels",
  group: "vesper",
  glyph: ICONS.channels,
  async mount(host: HTMLElement, ctx: SectionContext) {
    host.append(sectionHeader("Channels", "Where Vesper can send and receive messages."));

    const messaging = h(
      "div",
      { class: "panel" },
      h("div", { class: "panel-title" }, "Messaging channels"),
    );
    host.append(messaging);

    try {
      const rows = await ctx.api.getJson<ChannelRow[]>("/api/connections");
      if (rows.length === 0) {
        messaging.append(h("p", { class: "muted" }, "No channels are wired yet."));
      } else {
        for (const c of rows) messaging.append(channelRow(c));
      }
    } catch (err) {
      messaging.append(
        h("p", { class: "muted" }, err instanceof Error ? err.message : "could not load channels"),
      );
    }

    const mcp = h("div", { class: "panel" }, h("div", { class: "panel-title" }, "MCP servers"));
    const chips = h("div", { style: "display:flex;flex-wrap:wrap;gap:6px" });
    for (const name of MCP) chips.append(h("span", { class: "badge" }, name));
    mcp.append(chips);
    host.append(mcp);

    host.append(
      h(
        "p",
        { class: "muted", style: "margin-top:16px" },
        "Channel tokens are set with the vesper CLI (read from stdin, stored in your OS keychain). " +
          "Connect Telegram to reach the chatbot from your phone.",
      ),
    );
  },
};
