/// <reference lib="dom" />
import { ICONS } from "../shell/icons.ts";
import { h, type SectionModule, sectionHeader } from "../shell/section.ts";

/** Client-side catalog — avoids coupling to WIP core connection wiring. */
const CHANNELS: readonly { readonly name: string; readonly status: "ready" | "deferred" }[] = [
  { name: "Telegram", status: "ready" },
  { name: "Discord", status: "ready" },
  { name: "WhatsApp", status: "deferred" },
  { name: "Signal", status: "deferred" },
];

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

/** ready => green badge, deferred => muted "soon" badge. */
function channelBadge(status: "ready" | "deferred"): HTMLElement {
  return status === "ready"
    ? h("span", { class: "badge ok" }, h("span", { class: "status-dot" }), "ready")
    : h("span", { class: "badge" }, "soon");
}

/**
 * Channels — the messaging surfaces and MCP servers a pipeline can reach. Static
 * catalog for now (decoupled from WIP core); becomes interactive in a later slice.
 */
export const channelsSection: SectionModule = {
  id: "channels",
  title: "Channels",
  group: "vesper",
  glyph: ICONS.channels,
  mount(host: HTMLElement) {
    host.append(sectionHeader("Channels", "Where Vesper can send and receive messages."));

    const messaging = h(
      "div",
      { class: "panel" },
      h("div", { class: "panel-title" }, "Messaging channels"),
    );
    for (const c of CHANNELS) {
      messaging.append(
        h("div", { class: "kv" }, h("span", { class: "k" }, c.name), channelBadge(c.status)),
      );
    }
    host.append(messaging);

    const mcp = h("div", { class: "panel" }, h("div", { class: "panel-title" }, "MCP servers"));
    const chips = h("div", { style: "display:flex;flex-wrap:wrap;gap:6px" });
    for (const name of MCP) chips.append(h("span", { class: "badge" }, name));
    mcp.append(chips);
    host.append(mcp);

    host.append(
      h(
        "p",
        { class: "muted", style: "margin-top:16px" },
        "Configure a channel's token with the vesper CLI; this surface will become interactive in a later slice.",
      ),
    );
  },
};
